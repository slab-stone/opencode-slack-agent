/**
 * Slack WebClient initialization + smart message sending utilities.
 */

import { WebClient } from "@slack/web-api";
import { SLACK_BOT_TOKEN, SLACK_MSG_LIMIT, SLACK_FILE_THRESHOLD } from "./types.js";
import { addWatchedThread } from "./db.js";

// ── Client Initialization ──────────────────────────────────────

if (!SLACK_BOT_TOKEN) {
  console.error("❌ SLACK_BOT_TOKEN environment variable is required");
  process.exit(1);
}

export const slack = new WebClient(SLACK_BOT_TOKEN, {
  headers: { "User-Agent": "opencode-slack-agent/1.0.0" },
});

// Bot user ID (resolved on startup)
let botUserId: string | undefined;

export async function resolveBotUserId(): Promise<string> {
  if (botUserId) return botUserId;
  try {
    const auth = await slack.auth.test();
    botUserId = auth.user_id as string;
    return botUserId;
  } catch {
    return "";
  }
}

export function getBotUserId(): string | undefined {
  return botUserId;
}

// ── Smart Message Sending ──────────────────────────────────────

/**
 * Automatically handles long messages:
 * - ≤3900 chars: send as-is
 * - 3900~8000 chars: split into multiple messages
 * - >8000 chars: upload as file
 */
export async function sendSmart(
  channel: string,
  text: string,
  options?: { thread_ts?: string; title?: string; filename?: string },
): Promise<{ ts: string; method: "message" | "chunked" | "file"; chunks?: number }> {
  const len = text.length;

  if (len <= SLACK_MSG_LIMIT) {
    const result = await slack.chat.postMessage({
      channel,
      text,
      thread_ts: options?.thread_ts,
      mrkdwn: true,
    });
    const ts = result.ts || "";
    if (ts) addWatchedThread(channel, options?.thread_ts || ts, "sendSmart:message");
    return { ts, method: "message" };
  }

  if (len <= SLACK_FILE_THRESHOLD) {
    const chunks = splitMessage(text, SLACK_MSG_LIMIT);
    let firstTs = "";
    for (let i = 0; i < chunks.length; i++) {
      const prefix = chunks.length > 1 ? `_(${i + 1}/${chunks.length})_\n` : "";
      const chunkThreadTs = i === 0
        ? options?.thread_ts
        : (firstTs || options?.thread_ts || undefined);
      const result = await slack.chat.postMessage({
        channel,
        text: prefix + chunks[i],
        thread_ts: chunkThreadTs,
        mrkdwn: true,
      });
      if (i === 0 && result.ts) firstTs = result.ts;
    }
    if (firstTs) addWatchedThread(channel, options?.thread_ts || firstTs, "sendSmart:chunked");
    return { ts: firstTs, method: "chunked", chunks: chunks.length };
  }

  // Upload as file
  const filename = options?.filename || `output-${Date.now()}.txt`;
  const title = options?.title || "📄 Output";
  const uploadResult = await uploadContent(channel, text, {
    filename,
    title,
    thread_ts: options?.thread_ts,
  });
  if (uploadResult.ts || options?.thread_ts) {
    addWatchedThread(channel, options?.thread_ts || uploadResult.ts, "sendSmart:file");
  }
  return { ts: uploadResult.ts, method: "file" };
}

// ── Helpers ────────────────────────────────────────────────────

export function splitMessage(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  const lines = text.split("\n");
  let current = "";

  for (const line of lines) {
    if (line.length > maxLen) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < line.length; i += maxLen) {
        chunks.push(line.slice(i, i + maxLen));
      }
      continue;
    }

    if (current.length + line.length + 1 > maxLen) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? current + "\n" + line : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function uploadContent(
  channel: string,
  content: string,
  options: { filename: string; title: string; thread_ts?: string },
): Promise<{ ts: string; fileId: string }> {
  const args: Record<string, unknown> = {
    channel_id: channel,
    content,
    filename: options.filename,
    title: options.title,
  };
  if (options.thread_ts) args.thread_ts = options.thread_ts;

  const result = await slack.filesUploadV2(args as unknown as Parameters<typeof slack.filesUploadV2>[0]);
  const file = (result as { files?: Array<{ id?: string }> }).files?.[0];
  return {
    ts: options.thread_ts || "",
    fileId: file?.id || "",
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
