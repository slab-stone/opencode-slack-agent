/**
 * Shared type definitions for the OpenCode Slack MCP Server.
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ── Paths & Constants ──────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const STATE_DIR = resolve(__dirname, "..");
export const DB_FILE = resolve(STATE_DIR, "slack_mcp.db");

// Slack message limits
export const SLACK_MSG_LIMIT = 3900;
export const SLACK_FILE_THRESHOLD = 8000;

// ── Configuration ──────────────────────────────────────────────

export const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
export const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
export const SLACK_DEFAULT_CHANNEL = process.env.SLACK_DEFAULT_CHANNEL || "";

// ── Slack Types ────────────────────────────────────────────────

export interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
  permalink?: string;
}

export interface SlackMessage {
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  files?: SlackFile[];
}

// ── Inbox Types ────────────────────────────────────────────────

export interface InboxRow {
  id: number;
  channel_id: string;
  message_ts: string;
  thread_ts: string | null;
  user_id: string | null;
  text: string | null;
  raw_json: string | null;
  status: string;
  fetched_at: string;
  read_at: string | null;
  read_by: string | null;
}

export interface WatchedThread {
  channel_id: string;
  thread_ts: string;
  context: string;
  created_at: string;
}
