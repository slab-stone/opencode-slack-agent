/**
 * Basic Slack tools: send_message, respond, read_messages, reply_thread, add_reaction.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SlackMessage } from "../types.js";
import { SLACK_DEFAULT_CHANNEL } from "../types.js";
import { slack, resolveBotUserId, sendSmart } from "../slack-client.js";
import { inboxIngest, setChannelCursor } from "../db.js";

function resolveChannel(channel?: string): string {
  return channel || SLACK_DEFAULT_CHANNEL;
}

function formatMessages(messages: SlackMessage[]): string {
  if (messages.length === 0) return "메시지가 없습니다.";
  return messages.map((m) => {
    const thread = m.thread_ts ? ` (thread: ${m.thread_ts})` : "";
    return `[${m.ts}] <${m.user}>${thread}: ${m.text}`;
  }).join("\n");
}

export function registerBasicTools(server: McpServer): void {

  // ── slack_send_message ───────────────────────────────────────

  server.tool(
    "slack_send_message",
    "Slack 채널에 메시지를 전송합니다. 긴 메시지는 자동 분할 또는 파일 업로드됩니다.",
    {
      message: z.string().describe("전송할 메시지 텍스트 (Slack mrkdwn 포맷 지원)"),
      channel: z.string().optional().describe("Slack 채널 ID (미지정 시 기본 채널 사용)"),
      thread_ts: z.string().optional().describe("스레드에 답장할 경우 ts 값"),
    },
    async ({ message, channel, thread_ts }) => {
      const ch = resolveChannel(channel);
      const result = await sendSmart(ch, message, { thread_ts });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ok: true,
            channel: ch,
            ts: result.ts,
            method: result.method,
            chunks: result.chunks,
          }, null, 2),
        }],
      };
    },
  );

  // ── slack_respond ────────────────────────────────────────────

  server.tool(
    "slack_respond",
    "사용자 명령에 응답합니다. thread_ts 유무에 따라 스레드 답장 또는 채널 메시지를 자동 라우팅합니다.",
    {
      message: z.string().describe("응답 메시지 텍스트 (Slack mrkdwn 지원)"),
      channel: z.string().optional().describe("Slack 채널 ID"),
      thread_ts: z.string().optional().describe("원본 메시지의 thread_ts"),
    },
    async ({ message, channel, thread_ts }) => {
      const ch = resolveChannel(channel);
      const result = await sendSmart(ch, message, thread_ts ? { thread_ts } : undefined);
      const mode = thread_ts ? "thread_reply" : "channel_message";

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ok: true,
            channel: ch,
            ts: result.ts,
            ...(thread_ts ? { thread_ts } : {}),
            mode,
            method: result.method,
          }, null, 2),
        }],
      };
    },
  );

  // ── slack_read_messages ──────────────────────────────────────

  server.tool(
    "slack_read_messages",
    "Slack 채널의 최근 메시지를 읽어옵니다.",
    {
      channel: z.string().optional().describe("Slack 채널 ID (미지정 시 기본 채널)"),
      limit: z.number().min(1).max(100).default(10).describe("가져올 메시지 수 (기본: 10)"),
      oldest: z.string().optional().describe("이 타임스탬프 이후의 메시지만 가져옴"),
    },
    async ({ channel, limit, oldest }) => {
      const ch = resolveChannel(channel);
      const result = await slack.conversations.history({
        channel: ch,
        limit,
        ...(oldest ? { oldest } : {}),
      });
      const messages = (result.messages || []) as SlackMessage[];
      const sorted = [...messages].reverse();

      if (sorted.length > 0) {
        inboxIngest(ch, sorted);
        setChannelCursor(ch, sorted[sorted.length - 1].ts);
      }

      return {
        content: [{ type: "text" as const, text: formatMessages(sorted) }],
      };
    },
  );

  // ── slack_reply_thread ───────────────────────────────────────

  server.tool(
    "slack_reply_thread",
    "특정 메시지의 스레드에 답장합니다.",
    {
      thread_ts: z.string().describe("답장할 원본 메시지의 ts"),
      message: z.string().describe("답장 메시지 텍스트"),
      channel: z.string().optional().describe("Slack 채널 ID"),
    },
    async ({ thread_ts, message, channel }) => {
      const ch = resolveChannel(channel);
      const result = await sendSmart(ch, message, { thread_ts });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ok: true,
            channel: ch,
            ts: result.ts,
            thread_ts,
            method: result.method,
          }, null, 2),
        }],
      };
    },
  );

  // ── slack_get_thread ─────────────────────────────────────────

  server.tool(
    "slack_get_thread",
    "특정 메시지의 전체 스레드를 읽어옵니다.",
    {
      thread_ts: z.string().describe("스레드 원본 메시지의 ts"),
      channel: z.string().optional().describe("Slack 채널 ID"),
      limit: z.number().min(1).max(200).default(50).describe("가져올 메시지 수"),
    },
    async ({ thread_ts, channel, limit }) => {
      const ch = resolveChannel(channel);
      const result = await slack.conversations.replies({
        channel: ch,
        ts: thread_ts,
        limit,
      });
      const messages = (result.messages || []) as SlackMessage[];

      return {
        content: [{ type: "text" as const, text: formatMessages(messages) }],
      };
    },
  );

  // ── slack_add_reaction ───────────────────────────────────────

  server.tool(
    "slack_add_reaction",
    "메시지에 이모지 리액션을 추가합니다.",
    {
      timestamp: z.string().describe("리액션을 달 메시지의 ts"),
      reaction: z.string().default("eyes").describe("이모지 이름 (콜론 없이). 예: eyes, white_check_mark, rocket"),
      channel: z.string().optional().describe("Slack 채널 ID"),
    },
    async ({ timestamp, reaction, channel }) => {
      const ch = resolveChannel(channel);
      try {
        await slack.reactions.add({ channel: ch, name: reaction, timestamp });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("already_reacted")) {
          return { content: [{ type: "text" as const, text: `✅ :${reaction}: already exists` }] };
        }
        throw err;
      }
      return { content: [{ type: "text" as const, text: `✅ :${reaction}: added (ts: ${timestamp})` }] };
    },
  );

  // ── slack_list_channels ──────────────────────────────────────

  server.tool(
    "slack_list_channels",
    "봇이 접근할 수 있는 Slack 채널 목록을 조회합니다.",
    {
      limit: z.number().min(1).max(200).default(50).describe("가져올 채널 수 (기본: 50)"),
    },
    async ({ limit }) => {
      const result = await slack.conversations.list({
        types: "public_channel,private_channel",
        limit,
        exclude_archived: true,
      });

      const channels = (result.channels || []).map((ch) => ({
        id: ch.id,
        name: ch.name,
        is_member: ch.is_member,
      }));

      return { content: [{ type: "text" as const, text: JSON.stringify(channels, null, 2) }] };
    },
  );

  // ── slack_resolve_channel ───────────────────────────────────

  server.tool(
    "slack_resolve_channel",
    "채널 ID, 이름(#general), 또는 Slack URL을 입력하면 채널 ID로 resolve합니다. DM의 경우 사용자 ID나 이름으로도 resolve 가능합니다.",
    {
      input: z.string().describe("채널 ID (C/D/G로 시작), 채널 이름 (#general 또는 general), Slack URL (https://xxx.slack.com/archives/C...), 또는 DM 대상 사용자 ID"),
    },
    async ({ input }) => {
      const trimmed = input.trim();

      // 1. Already a channel ID (C, D, G prefix + alphanumeric)
      if (/^[CDG][A-Z0-9]{8,}$/i.test(trimmed)) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, channel_id: trimmed, source: "direct_id" }, null, 2) }] };
      }

      // 2. Slack URL: extract channel ID from /archives/CXXXXXX
      const urlMatch = trimmed.match(/\/archives\/([CDG][A-Z0-9]+)/i);
      if (urlMatch) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, channel_id: urlMatch[1], source: "url" }, null, 2) }] };
      }

      // 3. User ID (U prefix) → open DM
      if (/^U[A-Z0-9]{8,}$/i.test(trimmed)) {
        const dm = await slack.conversations.open({ users: trimmed });
        const channelId = dm.channel?.id;
        if (channelId) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, channel_id: channelId, source: "dm_open", user: trimmed }, null, 2) }] };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: `Cannot open DM with user ${trimmed}` }, null, 2) }] };
      }

      // 4. Channel name (with or without #)
      const name = trimmed.replace(/^#/, "").toLowerCase();

      // Search in public + private channels
      let cursor: string | undefined;
      for (let i = 0; i < 5; i++) {
        const result = await slack.conversations.list({
          types: "public_channel,private_channel,im,mpim",
          limit: 200,
          exclude_archived: true,
          ...(cursor ? { cursor } : {}),
        });

        const found = (result.channels || []).find(
          (ch) => ch.name?.toLowerCase() === name || ch.id === trimmed,
        );
        if (found) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, channel_id: found.id, name: found.name, source: "name_lookup" }, null, 2) }] };
        }

        cursor = result.response_metadata?.next_cursor;
        if (!cursor) break;
      }

      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: `Channel not found: "${input}". Try channel ID directly.` }, null, 2) }] };
    },
  );
}
