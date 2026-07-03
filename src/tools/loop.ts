/**
 * Command loop tools: slack_command_loop, slack_check_inbox.
 * With Socket Mode, messages are automatically pushed to inbox.
 * These tools just read from SQLite — no API polling needed.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InboxRow } from "../types.js";
import { SLACK_DEFAULT_CHANNEL } from "../types.js";
import { slack, resolveBotUserId, sleep } from "../slack-client.js";
import {
  inboxGetUnread, inboxMarkAllRead,
  setChannelCursor, addWatchedThread,
} from "../db.js";

function resolveChannel(channel?: string): string | undefined {
  if (channel === "") return undefined;
  return channel || SLACK_DEFAULT_CHANNEL || undefined;
}

// ── Reaction-as-Command mapping ────────────────────────────────

const REACTION_COMMANDS: Record<string, string> = {
  white_check_mark: "승인",
  heavy_check_mark: "승인",
  "+1": "승인",
  thumbsup: "승인",
  rocket: "진행",
  x: "거부",
  "-1": "거부",
  thumbsdown: "거부",
  no_entry_sign: "중단",
  eyes: "_ack_",
  repeat: "재시도",
  recycle: "재시도",
  wastebasket: "취소",
  question: "설명해줘",
};

// ── Enrichment ─────────────────────────────────────────────────

function enrichMessage(msg: { text: string | null; user: string | null; ts: string; thread_ts?: string | null; channel_id?: string | null }, channel?: string) {
  const ch = msg.channel_id || channel || "";
  return {
    text: msg.text || "",
    user: msg.user || "unknown",
    ts: msg.ts,
    thread_ts: msg.thread_ts || undefined,
    channel: ch,
    reply_to: msg.thread_ts
      ? { method: "slack_respond", channel: ch, thread_ts: msg.thread_ts }
      : { method: "slack_respond", channel: ch },
  };
}

/**
 * Parse reaction inbox entries (stored by socket.ts as "[reaction:name]") into commands.
 */
function parseReactionEntry(text: string): { reaction: string; command: string } | null {
  const match = text.match(/^\[reaction:(.+)\]$/);
  if (!match) return null;
  const reaction = match[1];
  const command = REACTION_COMMANDS[reaction];
  if (!command || command === "_ack_") return null;
  return { reaction, command };
}

export function registerLoopTools(server: McpServer): void {

  // ── slack_check_inbox ────────────────────────────────────────

  server.tool(
    "slack_check_inbox",
    "인박스에서 미읽 메시지를 확인합니다. Socket Mode가 실시간으로 수집하므로 즉시 반환됩니다.",
    {
      channel: z.string().optional().describe("채널 ID (미지정 시 전체 채널의 미읽 메시지 확인)"),
      mark_as_read: z.boolean().default(true).describe("true: 읽은 후 인박스에서 제거"),
    },
    async ({ channel, mark_as_read }) => {
      const ch = resolveChannel(channel);
      const myUserId = await resolveBotUserId();

      let unread = inboxGetUnread(ch);
      unread = unread.filter((r) => r.user_id !== myUserId);

      if (mark_as_read && unread.length > 0) {
        inboxMarkAllRead(ch, "check_inbox");
      }

      if (unread.length > 0) {
        const latest = unread[unread.length - 1];
        const ackChannel = latest.channel_id || ch;
        if (ackChannel) {
          try { await slack.reactions.add({ channel: ackChannel, name: "eyes", timestamp: latest.message_ts }); } catch {}
        }
      }

      const reactionEntries = unread.filter((r) => r.text?.startsWith("[reaction:"));
      const normalMessages = unread.filter((r) => !r.text?.startsWith("[reaction:"));

      const reactions = reactionEntries
        .map((r) => {
          const parsed = parseReactionEntry(r.text || "");
          if (!parsed) return null;
          return { ...parsed, user: r.user_id, ts: r.message_ts };
        })
        .filter(Boolean);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            unread_count: normalMessages.length,
            reactions_count: reactions.length,
            channel: ch || "all",
            messages: normalMessages.map((r) => enrichMessage(
              { text: r.text, user: r.user_id, ts: r.message_ts, thread_ts: r.thread_ts, channel_id: r.channel_id }, ch,
            )),
            reactions,
            hint: normalMessages.length > 0
              ? `미읽 메시지 ${normalMessages.length}건.`
              : "미읽 메시지가 없습니다.",
          }, null, 2),
        }],
      };
    },
  );

  // ── slack_command_loop ───────────────────────────────────────

  server.tool(
    "slack_command_loop",
    "Slack에서 사용자의 다음 명령을 대기합니다. Socket Mode로 실시간 수신되므로 inbox를 확인하며 대기합니다. timeout_seconds=0이면 논블로킹(1회 확인 후 즉시 반환).",
    {
      channel: z.string().optional().describe("명령을 수신할 Slack 채널 ID. 미지정 시 모든 채널의 멘션/DM에 응답."),
      timeout_seconds: z.number().min(0).max(55).default(30).describe("대기 시간 (초). 0=논블로킹. 기본 30초. MCP request timeout(60초) 이내여야 합니다."),
      poll_interval_seconds: z.number().min(1).max(30).default(2).describe("인박스 확인 간격 (초). Socket Mode라 짧아도 API 호출 없음. 기본 2초."),
      greeting: z.string().optional().describe("대기 시작 시 채널에 보낼 메시지"),
    },
    async ({ channel, timeout_seconds, poll_interval_seconds, greeting }) => {
      const ch = resolveChannel(channel);
      const myUserId = await resolveBotUserId();

      if (greeting && ch) {
        const greetMsg = await slack.chat.postMessage({ channel: ch, text: greeting, mrkdwn: true });
        if (greetMsg.ts) {
          setChannelCursor(ch, greetMsg.ts);
          addWatchedThread(ch, greetMsg.ts, "command_loop:greeting");
        }
      }

      const deadline = Date.now() + timeout_seconds * 1000;
      const interval = poll_interval_seconds * 1000;

      const checkInbox = (): { userMsgs: InboxRow[]; reactionMsgs: InboxRow[] } => {
        const all = inboxGetUnread(ch).filter((r) => r.user_id !== myUserId);
        const userMsgs = all.filter((r) => !r.text?.startsWith("[reaction:"));
        const reactionMsgs = all.filter((r) => r.text?.startsWith("[reaction:"));
        return { userMsgs, reactionMsgs };
      };

      const buildResponse = async (userMsgs: InboxRow[], reactionMsgs: InboxRow[], source: string, nonBlocking = false) => {
        inboxMarkAllRead(ch, "command_loop");
        const latest = userMsgs[userMsgs.length - 1];
        const latestChannel = latest?.channel_id || ch || "";

        if (latest && latestChannel) {
          setChannelCursor(latestChannel, latest.message_ts);
          try { await slack.reactions.add({ channel: latestChannel, name: "eyes", timestamp: latest.message_ts }); } catch {}
        }

        const reactions = reactionMsgs
          .map((r) => {
            const parsed = parseReactionEntry(r.text || "");
            if (!parsed) return null;
            return { ...parsed, user: r.user_id, ts: r.message_ts };
          })
          .filter(Boolean);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              command_received: true,
              source,
              ...(nonBlocking ? { non_blocking: true } : {}),
              ...(latest ? enrichMessage(
                { text: latest.text, user: latest.user_id, ts: latest.message_ts, thread_ts: latest.thread_ts, channel_id: latest.channel_id }, ch,
              ) : {}),
              channel: latestChannel || ch || "all",
              all_messages: userMsgs.map((r) => enrichMessage(
                { text: r.text, user: r.user_id, ts: r.message_ts, thread_ts: r.thread_ts, channel_id: r.channel_id }, ch,
              )),
              unread_count: userMsgs.length,
              ...(reactions.length > 0 ? { reactions } : {}),
            }, null, 2),
          }],
        };
      };

      const buildReactionResponse = (reactionMsgs: InboxRow[], nonBlocking = false) => {
        inboxMarkAllRead(ch, "command_loop");
        const first = reactionMsgs[0];
        const parsed = parseReactionEntry(first.text || "");
        const rxnChannel = first.channel_id || ch || "";
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              command_received: true,
              source: "reaction",
              ...(nonBlocking ? { non_blocking: true } : {}),
              text: parsed?.command || "",
              reaction: parsed?.reaction || "",
              user: first.user_id,
              channel: rxnChannel,
              reply_to: { method: "slack_respond", channel: rxnChannel },
            }, null, 2),
          }],
        };
      };

      // ── Immediate check ──────────────────────────────────────
      const { userMsgs, reactionMsgs } = checkInbox();
      if (userMsgs.length > 0) {
        return buildResponse(userMsgs, reactionMsgs, "inbox_backlog");
      }
      if (reactionMsgs.length > 0) {
        return buildReactionResponse(reactionMsgs);
      }

      // ── Non-blocking mode ────────────────────────────────────
      if (timeout_seconds === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              command_received: false,
              non_blocking: true,
              channel: ch || "all",
              hint: "논블로킹: 새 명령 없음. 현재 작업을 계속 진행하세요.",
            }, null, 2),
          }],
        };
      }

      // ── Blocking wait (inbox is populated by Socket Mode in real-time) ──
      while (Date.now() < deadline) {
        await sleep(interval);

        const { userMsgs: msgs, reactionMsgs: rxns } = checkInbox();
        if (msgs.length > 0) {
          return buildResponse(msgs, rxns, "inbox");
        }
        if (rxns.length > 0) {
          return buildReactionResponse(rxns);
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            command_received: false,
            timeout: true,
            waited_seconds: timeout_seconds,
            channel: ch || "all",
            hint: "타임아웃. slack_command_loop()를 다시 호출하여 대기를 재개하세요.",
          }, null, 2),
        }],
      };
    },
  );
}
