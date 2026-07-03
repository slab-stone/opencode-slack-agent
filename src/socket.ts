/**
 * Socket Mode client for real-time Slack event reception.
 * Receives messages via WebSocket push — no polling needed.
 */

import { SocketModeClient } from "@slack/socket-mode";
import { SLACK_APP_TOKEN, SLACK_DEFAULT_CHANNEL } from "./types.js";
import type { SlackMessage } from "./types.js";
import { inboxIngest, addWatchedThread } from "./db.js";
import { getBotUserId } from "./slack-client.js";

let socketClient: SocketModeClient | null = null;

export function getSocketClient(): SocketModeClient | null {
  return socketClient;
}

/**
 * Start Socket Mode connection.
 * Listens for message events and ingests them into the inbox automatically.
 */
export async function startSocketMode(): Promise<void> {
  if (!SLACK_APP_TOKEN) {
    console.error("⚠️ SLACK_APP_TOKEN not set — Socket Mode disabled, falling back to polling");
    return;
  }

  socketClient = new SocketModeClient({
    appToken: SLACK_APP_TOKEN,
    logLevel: undefined, // quiet
  });

  // ── Handle message events ────────────────────────────────────
  socketClient.on("message", async ({ event, ack }) => {
    await ack();

    const botId = getBotUserId();
    if (event.bot_id || (botId && event.user === botId)) return;
    if (event.subtype && event.subtype !== "file_share") return;

    const channel = event.channel as string;
    const msg: SlackMessage = {
      user: event.user || "",
      text: event.text || "",
      ts: event.ts || "",
      thread_ts: event.thread_ts || undefined,
      files: event.files || undefined,
    };

    inboxIngest(channel, [msg]);

    if (msg.thread_ts) {
      addWatchedThread(channel, msg.thread_ts, "socket:thread_reply");
    }
  });

  // ── Handle app_mention events ───────────────────────────────
  socketClient.on("app_mention", async ({ event, ack }) => {
    await ack();

    const botId = getBotUserId();
    if (botId && event.user === botId) return;

    const channel = event.channel as string;
    const msg: SlackMessage = {
      user: event.user || "",
      text: event.text || "",
      ts: event.ts || "",
      thread_ts: event.thread_ts || undefined,
      files: event.files || undefined,
    };

    inboxIngest(channel, [msg]);

    if (msg.thread_ts) {
      addWatchedThread(channel, msg.thread_ts, "socket:mention_thread");
    }
  });

  // ── Handle reaction events ───────────────────────────────────
  socketClient.on("reaction_added", async ({ event, ack }) => {
    await ack();
    // We store reactions as a special inbox entry for the command loop to pick up
    const botId = getBotUserId();
    if (botId && event.user === botId) return;

    const channel = event.item?.channel as string;
    if (!channel) return;

    const reactionMsg: SlackMessage = {
      user: event.user || "",
      text: `[reaction:${event.reaction}]`,
      ts: event.event_ts || "",
      thread_ts: undefined,
    };

    inboxIngest(channel, [reactionMsg]);
  });

  // ── Connection lifecycle ─────────────────────────────────────
  socketClient.on("connected", () => {
    console.error("🔌 Socket Mode connected — real-time events active");
  });

  socketClient.on("disconnected", () => {
    console.error("⚠️ Socket Mode disconnected — will auto-reconnect");
  });

  await socketClient.start();
}

export async function stopSocketMode(): Promise<void> {
  if (socketClient) {
    await socketClient.disconnect();
    socketClient = null;
  }
}
