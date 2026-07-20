#!/usr/bin/env node
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { readFileSync, appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import * as https from "https";

const LOG_DIR = join(homedir(), ".local/share/opencode/log");
const LOG_FILE = join(LOG_DIR, "slack-agent-plugin.log");
const log = (m) => {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] worker: ${m}\n`);
  } catch {}
};

const SLACK_MSG_LIMIT = 3900;
const botToken = process.env.SLACK_BOT_TOKEN;
const appToken = process.env.SLACK_APP_TOKEN;
const caCerts = process.env.NODE_EXTRA_CA_CERTS;

// Slack "thinking" indicator (assistant.threads.setStatus).
// Auto-clears when chat.postMessage fires in the thread — we restore it after
// each sendToSlack so it persists for the entire processing duration.
//
// Do NOT customize `status` — keep Slack's conventional "is thinking..."
// (renders as "<Bot> is thinking..."). Only override `loading_messages`;
// if omitted, Slack rotates its own AI phrases ("Analysing...", etc.).
const INSTANT_REACTION_NAME = "eyes";
const THINKING_STATUS_REFRESH_MS = 90_000; // refresh before Slack's 2-min timeout
const THINKING_STATUS_TEXT = "is thinking...";
const THINKING_LOADING_MESSAGES = [
  "Thinking.",
  "Thinking..",
  "Thinking...",
];
const activeThinking = new Map(); // key: `${channelId}:${threadTs}` -> interval

if (!botToken || !appToken) {
  process.exit(1);
}

let agent;
if (caCerts) {
  try {
    const ca = readFileSync(caCerts);
    agent = new https.Agent({ ca });
  } catch {}
}

const slack = new WebClient(botToken, agent ? { agent, tls: { ca: agent.options.ca } } : undefined);
const socketClient = new SocketModeClient({ appToken });

let botUserId;
const EVENT_DEDUPE_TTL_MS = 10 * 60 * 1000;
const seenEventKeys = new Map();

function formatInboundMeta(body, ev) {
  const eventId = typeof body?.event_id === "string" ? body.event_id : "-";
  const eventType = typeof ev?.type === "string" ? ev.type : "-";
  const channel = typeof ev?.channel === "string" ? ev.channel : "-";
  const ts = typeof ev?.ts === "string" ? ev.ts : "-";
  const threadTs = typeof ev?.thread_ts === "string" ? ev.thread_ts : "-";
  const user = typeof ev?.user === "string" ? ev.user : "-";
  return `event_id=${eventId} type=${eventType} channel=${channel} ts=${ts} thread_ts=${threadTs} user=${user}`;
}

function buildEventKey(body, ev) {
  const channel = typeof ev?.channel === "string" ? ev.channel : "";
  const ts = typeof ev?.ts === "string" ? ev.ts : "";
  if (channel && ts) return `msg:${channel}:${ts}`;
  const eventId = typeof body?.event_id === "string" ? body.event_id : "";
  if (eventId) return `event:${eventId}`;
  return "";
}

function shouldProcessEvent(eventKey) {
  if (!eventKey) return true;
  const now = Date.now();
  for (const [key, expiresAt] of seenEventKeys) {
    if (expiresAt <= now) seenEventKeys.delete(key);
  }
  if (seenEventKeys.has(eventKey)) return false;
  seenEventKeys.set(eventKey, now + EVENT_DEDUPE_TTL_MS);
  return true;
}

async function init() {
  const auth = await slack.auth.test();
  botUserId = auth.user_id;
  log(`ready: bot=${botUserId}`);
}

// Markdown -> Slack mrkdwn conversion (duplicated from plugin.ts because the
// worker needs it for final stream render and plugin/worker can't share code).
function markdownToSlackMrkdwn(text) {
  let result = text;
  const codeBlocks = [];
  result = result.replace(/```[\w]*\n([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(code);
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
  });
  const inlineCodes = [];
  result = result.replace(/`([^`]+)`/g, (_, code) => {
    inlineCodes.push(code);
    return `\x00INLINE${inlineCodes.length - 1}\x00`;
  });
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
  result = result.replace(/\*\*+/g, "*");
  result = result.replace(/~~(.+?)~~/g, "~$1~");
  result = result.replace(/^(\s*)[-*]\s+/gm, "$1• ");
  for (let i = 0; i < inlineCodes.length; i++) {
    result = result.replace(`\x00INLINE${i}\x00`, `\`${inlineCodes[i]}\``);
  }
  for (let i = 0; i < codeBlocks.length; i++) {
    result = result.replace(`\x00CODEBLOCK${i}\x00`, "```\n" + codeBlocks[i] + "```");
  }
  return result;
}

async function sendToSlack(channel, text, threadTs) {
  try {
    if (text.length <= SLACK_MSG_LIMIT) {
      await slack.chat.postMessage({ channel, text, thread_ts: threadTs, mrkdwn: true });
    } else {
      const chunks = [];
      const lines = text.split("\n");
      let current = "";
      for (const line of lines) {
        if (current.length + line.length + 1 > SLACK_MSG_LIMIT) {
          chunks.push(current);
          current = line;
        } else {
          current = current ? current + "\n" + line : line;
        }
      }
      if (current) chunks.push(current);
      for (let i = 0; i < chunks.length; i++) {
        const prefix = chunks.length > 1 ? `_(${i + 1}/${chunks.length})_\n` : "";
        await slack.chat.postMessage({
          channel,
          text: prefix + chunks[i],
          thread_ts: threadTs || undefined,
          mrkdwn: true,
        });
      }
    }
  } catch {}
  // chat.postMessage clears the indicator — re-assert if still processing.
  restoreThinkingIfActive(channel, threadTs);
}

async function addReaction(channel, name, timestamp) {
  try { await slack.reactions.add({ channel, name, timestamp }); } catch {}
}

function thinkingKey(channelId, threadTs) {
  return `${channelId}:${threadTs}`;
}

// Calls assistant.threads.setStatus via the low-level apiCall so this works
// on any @slack/web-api version (the typed binding `slack.assistant.threads.setStatus`
// only exists on >=7.10.0). Required scope: chat:write (already granted).
async function setAssistantStatus(channelId, threadTs, status, loadingMessages) {
  try {
    await slack.apiCall("assistant.threads.setStatus", {
      channel_id: channelId,
      thread_ts: threadTs,
      status,
      ...(loadingMessages ? { loading_messages: loadingMessages } : {}),
    });
    return true;
  } catch (e) {
    log(`assistant.threads.setStatus (${status ? "set" : "clear"}) failed: ${e?.message || e}`);
    return false;
  }
}

function assertThinkingStatus(channelId, threadTs) {
  // status stays at Slack's default wording; only loading_messages are customized.
  setAssistantStatus(channelId, threadTs, THINKING_STATUS_TEXT, THINKING_LOADING_MESSAGES);
}

function restoreThinkingIfActive(channelId, threadTs) {
  if (!channelId || !threadTs) return;
  if (!activeThinking.has(thinkingKey(channelId, threadTs))) return;
  assertThinkingStatus(channelId, threadTs);
}

function startThinking(channelId, threadTs) {
  const key = thinkingKey(channelId, threadTs);
  if (activeThinking.has(key)) return;
  assertThinkingStatus(channelId, threadTs);
  const interval = setInterval(() => {
    assertThinkingStatus(channelId, threadTs);
  }, THINKING_STATUS_REFRESH_MS);
  activeThinking.set(key, interval);
}

async function stopThinking(channelId, threadTs) {
  const key = thinkingKey(channelId, threadTs);
  const interval = activeThinking.get(key);
  if (interval) clearInterval(interval);
  activeThinking.delete(key);
  await setAssistantStatus(channelId, threadTs, "");
}

// --- Streaming response buffer ---
// ChatGPT-style streaming: post a placeholder on first delta, chat.update
// with growing text (throttled), then a final clean render on completion.
//
// State key: `${channelId}:${threadTs}:${messageID}:${partID}`
//   - per assistant text part (a single turn can have multiple text parts
//     across tool calls; each gets its own Slack message).
const STREAM_FLUSH_INTERVAL_MS = 1200; // throttle chat.update (~1/sec + buffer)
const STREAM_PLACEHOLDER_TEXT = "_…_";
const STREAM_OVERFLOW_NOTE = "\n\n_… (more in final reply)_";
const streamBuffers = new Map();

function streamKey(channelId, threadTs, messageID, partID) {
  return `${channelId}:${threadTs}:${messageID}:${partID}`;
}

async function handleStreamDelta({ channel, threadTs, messageID, partID, delta, fullText }) {
  if (!channel || !threadTs || !messageID || !partID) return;
  const key = streamKey(channel, threadTs, messageID, partID);
  let state = streamBuffers.get(key);
  if (!state) {
    state = {
      channel, threadTs, messageID, partID,
      messageTs: null,
      text: "",
      lastFlushAt: 0,
      flushTimer: null,
      finalized: false,
    };
    streamBuffers.set(key, state);
  }
  if (state.finalized) return;

  if (typeof fullText === "string") {
    state.text = fullText;
  } else if (typeof delta === "string") {
    state.text += delta;
  }
  if (!state.text) return;

  // Post placeholder on first delta and capture ts for later chat.update.
  if (!state.messageTs) {
    try {
      const result = await slack.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: STREAM_PLACEHOLDER_TEXT,
        mrkdwn: true,
      });
      state.messageTs = result?.ts || result?.message?.ts || null;
      state.lastFlushAt = Date.now();
      // postMessage auto-clears the thinking indicator — restore it so the
      // user sees activity while the response streams.
      restoreThinkingIfActive(channel, threadTs);
    } catch (e) {
      log(`stream placeholder post error: ${e?.message || e}`);
    }
    return;
  }

  // Throttle subsequent updates to ~1 per STREAM_FLUSH_INTERVAL_MS.
  const now = Date.now();
  if (now - state.lastFlushAt >= STREAM_FLUSH_INTERVAL_MS) {
    await flushStreamUpdate(state);
  } else if (!state.flushTimer) {
    state.flushTimer = setTimeout(() => {
      if (state.flushTimer) clearTimeout(state.flushTimer);
      state.flushTimer = null;
      flushStreamUpdate(state);
    }, STREAM_FLUSH_INTERVAL_MS);
  }
}

async function flushStreamUpdate(state) {
  if (!state.messageTs || !state.text || state.finalized) return;
  const display = state.text.length > SLACK_MSG_LIMIT
    ? state.text.slice(0, SLACK_MSG_LIMIT) + STREAM_OVERFLOW_NOTE
    : state.text;
  try {
    await slack.chat.update({
      channel: state.channel,
      ts: state.messageTs,
      text: display,
      mrkdwn: true,
    });
    state.lastFlushAt = Date.now();
  } catch (e) {
    log(`stream flush error: ${e?.message || e}`);
  }
}

async function finalizeStream({ channel, threadTs, messageID, partID, fullText }) {
  const key = streamKey(channel, threadTs, messageID, partID);
  const state = streamBuffers.get(key);
  const finalText = typeof fullText === "string" ? fullText : (state?.text || "");

  if (state?.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }

  if (!finalText.trim()) {
    // Nothing to show — delete the placeholder if one exists.
    if (state?.messageTs) {
      try { await slack.chat.delete({ channel, ts: state.messageTs }); } catch {}
    }
    if (state) streamBuffers.delete(key);
    return;
  }

  const rendered = markdownToSlackMrkdwn(finalText);
  const hasLongCode = rendered.includes("```") && rendered.length > 2000;
  const overflow = rendered.length > SLACK_MSG_LIMIT || hasLongCode;

  if (overflow) {
    // Replace the streaming placeholder with a brief note, then upload the
    // full response as a file (matches the non-streaming long-response path).
    if (state?.messageTs) {
      try {
        await slack.chat.update({
          channel: state.channel,
          ts: state.messageTs,
          text: "_full response in file below_",
          mrkdwn: true,
        });
      } catch {}
    }
    try {
      await slack.filesUploadV2({
        channel_id: channel,
        thread_ts: threadTs,
        content: finalText,
        filename: "response.md",
        title: "Response",
      });
    } catch (e) {
      log(`stream finalize upload error: ${e?.message || e}`);
      // Last-ditch fallback: chunked send.
      await sendToSlack(channel, rendered, threadTs);
    }
  } else if (state?.messageTs) {
    // Final clean render into the existing streaming message.
    try {
      await slack.chat.update({
        channel: state.channel,
        ts: state.messageTs,
        text: rendered,
        mrkdwn: true,
      });
    } catch (e) {
      log(`stream finalize update error: ${e?.message || e}`);
      await sendToSlack(channel, rendered, threadTs);
    }
  } else {
    // No placeholder was ever posted (post failed or only fullText given).
    await sendToSlack(channel, rendered, threadTs);
  }

  if (state) {
    state.finalized = true;
    streamBuffers.delete(key);
  }
}

async function abortStream({ channel, threadTs, messageID, partID }) {
  const key = streamKey(channel, threadTs, messageID, partID);
  const state = streamBuffers.get(key);
  if (!state) return;
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  // Best-effort: finalize with whatever text we have, so partial output
  // isn't lost on error. If empty, delete the placeholder.
  if (state.text && state.text.trim()) {
    await finalizeStream({ channel, threadTs, messageID, partID, fullText: state.text });
  } else if (state.messageTs) {
    try { await slack.chat.delete({ channel, ts: state.messageTs }); } catch {}
    streamBuffers.delete(key);
  } else {
    streamBuffers.delete(key);
  }
}

process.on("message", async (msg) => {
  if (msg?.type === "slack_send") {
    await sendToSlack(msg.channel, msg.text, msg.threadTs);
  } else if (msg?.type === "slack_update") {
    try { await slack.chat.update({ channel: msg.channel, ts: msg.ts, text: msg.text, mrkdwn: true }); } catch {}
  } else if (msg?.type === "slack_reaction") {
    await addReaction(msg.channel, msg.name, msg.timestamp);
  } else if (msg?.type === "slack_reaction_remove") {
    try { await slack.reactions.remove({ channel: msg.channel, name: msg.name, timestamp: msg.timestamp }); } catch {}
  } else if (msg?.type === "slack_thinking_clear") {
    await stopThinking(msg.channel, msg.threadTs);
  } else if (msg?.type === "slack_thinking_start") {
    startThinking(msg.channel, msg.threadTs);
  } else if (msg?.type === "slack_stream_delta") {
    await handleStreamDelta(msg);
  } else if (msg?.type === "slack_stream_finalize") {
    await finalizeStream(msg);
  } else if (msg?.type === "slack_stream_abort") {
    await abortStream(msg);
  } else if (msg?.type === "slack_upload") {
    try {
      await slack.filesUploadV2({
        channel_id: msg.channel,
        thread_ts: msg.threadTs,
        content: msg.content,
        filename: msg.filename || "response.md",
        title: msg.title || "Response",
      });
    } catch (e) {
      log(`upload error: ${e.message}`);
      await sendToSlack(msg.channel, msg.content, msg.threadTs);
    }
  } else if (msg?.type === "resolve_emails") {
    const resolved = [];
    for (const email of msg.emails || []) {
      try {
        const result = await slack.users.lookupByEmail({ email });
        if (result?.user?.id) resolved.push(result.user.id);
      } catch {}
    }
    if (resolved.length > 0 && process.send) {
      process.send({ type: "resolved_emails", users: resolved });
    }
  }
});

socketClient.on("slack_event", async ({ body, ack }) => {
  const ev = body?.event;
  log(`ingress received ${formatInboundMeta(body, ev)}`);

  if (ack) {
    try {
      await ack();
      log(`ingress ack sent ${formatInboundMeta(body, ev)}`);
    } catch (e) {
      log(`ingress ack failed ${formatInboundMeta(body, ev)} err=${e?.message || String(e)}`);
    }
  }

  if (!ev) return;

  const eventKey = buildEventKey(body, ev);
  if (!shouldProcessEvent(eventKey)) {
    log(`ingress duplicate skipped key=${eventKey} ${formatInboundMeta(body, ev)}`);
    return;
  }

  if (ev.type === "message" || ev.type === "app_mention") {
    if (ev.bot_id || ev.user === botUserId) {
      log(`ingress dropped reason=self_or_bot ${formatInboundMeta(body, ev)}`);
      return;
    }
    if (ev.subtype && ev.subtype !== "file_share") {
      log(`ingress dropped reason=subtype_${ev.subtype} ${formatInboundMeta(body, ev)}`);
      return;
    }
    if (!ev.channel || !ev.text || !ev.ts) {
      log(`ingress dropped reason=missing_required_fields ${formatInboundMeta(body, ev)}`);
      return;
    }

    const text = ev.type === "app_mention"
      ? ev.text.replace(/<@[A-Z0-9]+>/g, "").trim()
      : ev.text;

    if (text && process.send) {
      // INSTANT visual feedback: add 👀 reaction and set the "is thinking..."
      // assistant status BEFORE handing off to the plugin, so the user sees
      // acknowledgment the moment the message hits Slack (not after the plugin
      // wakes up, creates a session, etc.).
      const inboundTs = ev.ts;
      const inboundThreadTs = ev.thread_ts || ev.ts;
      addReaction(ev.channel, INSTANT_REACTION_NAME, inboundTs);
      startThinking(ev.channel, inboundThreadTs);

      process.send({
        type: "slack_event",
        channel: ev.channel,
        text,
        ts: ev.ts,
        threadTs: ev.thread_ts || ev.ts,
        messageTs: ev.ts,
        eventId: typeof body?.event_id === "string" ? body.event_id : undefined,
        user: ev.user,
      });
      log(`ingress forwarded_to_plugin key=${eventKey || "-"} ${formatInboundMeta(body, ev)} text_preview=${text.slice(0, 50)}`);
    }
  }
});

// --- Connection health monitoring ---
// SDK handles ping/pong internally (serverPingTimeout=30s, clientPingTimeout=5s).
// We only exit if SDK fires 'disconnected' AND fails to reconnect within RECONNECT_GRACE_MS.
const RECONNECT_GRACE_MS = 60000;
let outageStartedAt = null;

socketClient.on("connected", () => {
  outageStartedAt = null;
  log("Socket Mode connected");
  if (process.send) process.send({ type: "worker_connected" });
});

socketClient.on("disconnected", () => {
  if (!outageStartedAt) outageStartedAt = Date.now();
  log("Socket Mode disconnected — waiting for SDK auto-reconnect");
});

socketClient.on("reconnecting", () => {
  if (!outageStartedAt) outageStartedAt = Date.now();
  log("Socket Mode reconnecting...");
});

await init();
await socketClient.start();
log("worker running (idle-exit disabled, relying on SDK ping/pong health check)");

setInterval(() => {
  if (outageStartedAt) {
    const elapsed = Date.now() - outageStartedAt;
    if (elapsed > RECONNECT_GRACE_MS) {
      log(`connection unhealthy for ${Math.round(elapsed / 1000)}s with no reconnect — exiting for restart`);
      process.exit(1);
    }
  }
}, 15000);
