#!/usr/bin/env node
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { appendFileSync } from "fs";

const LOG = "/tmp/slack-agent-plugin.log";
const log = (m) => { try { appendFileSync(LOG, `[${new Date().toISOString()}] worker: ${m}\n`); } catch {} };

const botToken = process.env.SLACK_BOT_TOKEN;
const appToken = process.env.SLACK_APP_TOKEN;
const baseUrl = process.env.OPENCODE_BASE_URL;
const authHeader = process.env.OPENCODE_AUTH_HEADER || "";

if (!botToken || !appToken || !baseUrl) {
  log("missing env: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, OPENCODE_BASE_URL");
  process.exit(1);
}

const SLACK_MSG_LIMIT = 3900;
const slack = new WebClient(botToken);
const socketClient = new SocketModeClient({ appToken });

let botUserId;

async function init() {
  const auth = await slack.auth.test();
  botUserId = auth.user_id;
  log(`ready: bot=${botUserId}, baseUrl=${baseUrl}`);
}

async function apiCall(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (authHeader) headers["Authorization"] = authHeader;
  const resp = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`API ${resp.status}: ${text.slice(0, 100)}`);
  }
  const ct = resp.headers.get("content-type") || "";
  if (ct.includes("application/json")) return resp.json();
  return null;
}

async function sendToSlack(channel, text, threadTs) {
  if (text.length <= SLACK_MSG_LIMIT) {
    return slack.chat.postMessage({ channel, text, thread_ts: threadTs, mrkdwn: true });
  }
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

async function handleMessage(channel, text, ts) {
  log(`handleMessage: ${text.slice(0, 50)}`);
  try { await slack.reactions.add({ channel, name: "eyes", timestamp: ts }); } catch {}
  await sendToSlack(channel, "🔍 처리 중...", ts);

  try {
    const session = await apiCall("POST", "/session", { title: `Slack: ${text.slice(0, 50)}` });
    if (!session?.id) {
      await sendToSlack(channel, "❌ 세션 생성 실패", ts);
      return;
    }
    log(`session: ${session.id}`);

    await apiCall("POST", `/session/${session.id}/prompt_async`, { parts: [{ type: "text", text }] });
    log("prompt sent");

    // Poll for completion
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const messages = await apiCall("GET", `/session/${session.id}/message`);
        if (!Array.isArray(messages)) continue;
        const lastAssistant = [...messages].reverse().find(m => m.info?.role === "assistant");
        if (!lastAssistant?.info?.time?.completed) continue;

        const textParts = lastAssistant.parts
          .filter(p => p.type === "text" && p.text)
          .map(p => p.text)
          .join("\n");

        if (textParts) await sendToSlack(channel, textParts);
        try { await slack.reactions.add({ channel, name: "white_check_mark", timestamp: ts }); } catch {}
        log(`session ${session.id} completed`);
        return;
      } catch {}
    }
    await sendToSlack(channel, "⏱️ 타임아웃 (4분)", ts);
  } catch (e) {
    log(`error: ${e.message}`);
    await sendToSlack(channel, `❌ 오류: ${e.message}`, ts);
  }
}

socketClient.on("slack_event", async ({ body, ack }) => {
  if (ack) await ack();
  const ev = body?.event;
  if (!ev) return;

  if (ev.type === "message" || ev.type === "app_mention") {
    if (ev.bot_id || ev.user === botUserId) return;
    if (ev.subtype && ev.subtype !== "file_share") return;
    if (!ev.channel || !ev.text || !ev.ts) return;

    const text = ev.type === "app_mention"
      ? ev.text.replace(/<@[A-Z0-9]+>/g, "").trim()
      : ev.text;

    if (text) handleMessage(ev.channel, text, ev.ts);
  }
});

socketClient.on("connected", () => log("Socket Mode connected"));
socketClient.on("disconnected", () => log("Socket Mode disconnected"));

await init();
await socketClient.start();
log("worker running");
