/**
 * SQLite database initialization and data access helpers.
 * Manages inbox messages, channel cursors, and watched threads.
 */

import Database from "better-sqlite3";
import { DB_FILE } from "./types.js";
import type { SlackMessage, InboxRow, WatchedThread } from "./types.js";

// ── Database Initialization ────────────────────────────────────

const db = new Database(DB_FILE, {});
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    message_ts TEXT NOT NULL,
    thread_ts TEXT,
    user_id TEXT,
    text TEXT,
    raw_json TEXT,
    status TEXT DEFAULT 'unread',
    fetched_at TEXT DEFAULT (datetime('now')),
    read_at TEXT,
    read_by TEXT,
    UNIQUE(channel_id, message_ts)
  );

  CREATE TABLE IF NOT EXISTS channel_cursors (
    channel_id TEXT PRIMARY KEY,
    cursor_ts TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS watched_threads (
    channel_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    context TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(channel_id, thread_ts)
  );

  CREATE INDEX IF NOT EXISTS idx_inbox_channel_status
    ON inbox(channel_id, status);
  CREATE INDEX IF NOT EXISTS idx_inbox_channel_ts
    ON inbox(channel_id, message_ts);
`);

// ── Inbox Operations ───────────────────────────────────────────

const stmtInsertInbox = db.prepare(`
  INSERT OR IGNORE INTO inbox (channel_id, message_ts, thread_ts, user_id, text, raw_json)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const stmtGetUnread = db.prepare(`
  SELECT * FROM inbox
  WHERE channel_id = ? AND status = 'unread'
  ORDER BY message_ts ASC
`);

const stmtGetAllUnread = db.prepare(`
  SELECT * FROM inbox
  WHERE status = 'unread'
  ORDER BY message_ts ASC
`);

const stmtMarkAllRead = db.prepare(`
  UPDATE inbox
  SET status = 'read', read_at = datetime('now'), read_by = ?
  WHERE channel_id = ? AND status = 'unread'
`);

const stmtMarkAllReadGlobal = db.prepare(`
  UPDATE inbox
  SET status = 'read', read_at = datetime('now'), read_by = ?
  WHERE status = 'unread'
`);

const stmtUnreadCount = db.prepare(`
  SELECT COUNT(*) as count FROM inbox
  WHERE channel_id = ? AND status = 'unread'
`);

export function inboxIngest(channel: string, messages: SlackMessage[]): number {
  let inserted = 0;
  const ingestMany = db.transaction((msgs: SlackMessage[]) => {
    for (const m of msgs) {
      const result = stmtInsertInbox.run(
        channel,
        m.ts,
        m.thread_ts || null,
        m.user || null,
        m.text || null,
        JSON.stringify(m),
      );
      if (result.changes > 0) inserted++;
    }
  });
  ingestMany(messages);
  return inserted;
}

export function inboxGetUnread(channel?: string): InboxRow[] {
  if (channel) {
    return stmtGetUnread.all(channel) as InboxRow[];
  }
  return stmtGetAllUnread.all() as InboxRow[];
}

export function inboxMarkAllRead(channel: string | undefined, readBy: string): void {
  if (channel) {
    stmtMarkAllRead.run(readBy, channel);
  } else {
    stmtMarkAllReadGlobal.run(readBy);
  }
}

export function inboxUnreadCount(channel: string): number {
  const row = stmtUnreadCount.get(channel) as { count: number };
  return row.count;
}

// ── Channel Cursor Operations ──────────────────────────────────

const stmtGetCursor = db.prepare(`
  SELECT cursor_ts FROM channel_cursors WHERE channel_id = ?
`);

const stmtSetCursor = db.prepare(`
  INSERT INTO channel_cursors (channel_id, cursor_ts, updated_at)
  VALUES (?, ?, datetime('now'))
  ON CONFLICT(channel_id) DO UPDATE SET cursor_ts = excluded.cursor_ts, updated_at = datetime('now')
`);

export function getChannelCursor(channel: string): string | null {
  const row = stmtGetCursor.get(channel) as { cursor_ts: string } | undefined;
  return row?.cursor_ts || null;
}

export function setChannelCursor(channel: string, ts: string): void {
  stmtSetCursor.run(channel, ts);
}

// ── Watched Threads Operations ─────────────────────────────────

const stmtAddThread = db.prepare(`
  INSERT OR IGNORE INTO watched_threads (channel_id, thread_ts, context)
  VALUES (?, ?, ?)
`);

const stmtGetThreads = db.prepare(`
  SELECT * FROM watched_threads WHERE channel_id = ? ORDER BY created_at DESC
`);

const stmtThreadCount = db.prepare(`
  SELECT COUNT(*) as count FROM watched_threads WHERE channel_id = ?
`);

export function addWatchedThread(channel: string, threadTs: string, context: string): void {
  stmtAddThread.run(channel, threadTs, context);
}

export function getWatchedThreads(channel: string): WatchedThread[] {
  return stmtGetThreads.all(channel) as WatchedThread[];
}

export function getWatchedThreadCount(channel: string): number {
  const row = stmtThreadCount.get(channel) as { count: number };
  return row.count;
}

// ── Cleanup ────────────────────────────────────────────────────

export function closeDb(): void {
  db.close();
}
