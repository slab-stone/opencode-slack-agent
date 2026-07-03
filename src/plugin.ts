import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { createOpencodeClient } from "@opencode-ai/sdk";

type OpencodeClient = ReturnType<typeof createOpencodeClient>;

interface SlackEvent {
  user?: string;
  text?: string;
  ts?: string;
  channel?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
  files?: unknown[];
}

const SLACK_MSG_LIMIT = 3900;

function parsePortFromArgv(): string | undefined {
  const idx = process.argv.indexOf("--port");
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}

let slack: WebClient;
let socketClient: SocketModeClient;
let botUserId: string | undefined;
let client: OpencodeClient;

const activeSessions = new Map<string, { channel: string; ts: string }>();

async function resolveBotUserId(): Promise<string> {
  if (botUserId) return botUserId;
  const auth = await slack.auth.test();
  botUserId = auth.user_id as string;
  return botUserId;
}

async function sendToSlack(channel: string, text: string, threadTs?: string): Promise<string> {
  if (text.length <= SLACK_MSG_LIMIT) {
    const result = await slack.chat.postMessage({ channel, text, thread_ts: threadTs, mrkdwn: true });
    return result.ts || "";
  }
  const chunks: string[] = [];
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
  let firstTs = "";
  for (let i = 0; i < chunks.length; i++) {
    const prefix = chunks.length > 1 ? `_(${i + 1}/${chunks.length})_\n` : "";
    const result = await slack.chat.postMessage({
      channel,
      text: prefix + chunks[i],
      thread_ts: i === 0 ? threadTs : (firstTs || threadTs),
      mrkdwn: true,
    });
    if (i === 0 && result.ts) firstTs = result.ts;
  }
  return firstTs;
}

async function handleMessage(channel: string, text: string, ts: string): Promise<void> {
  try { await slack.reactions.add({ channel, name: "eyes", timestamp: ts }); } catch {}

  try {
    await sendToSlack(channel, "🔍 처리 중...", ts);

    const session = await client.session.create({ body: { title: `Slack: ${text.slice(0, 50)}` } });
    const sessionData = session.data as { id: string } | undefined;
    if (!sessionData?.id) {
      await sendToSlack(channel, "❌ 세션 생성 실패", ts);
      return;
    }

    activeSessions.set(sessionData.id, { channel, ts });

    await client.session.promptAsync({
      path: { id: sessionData.id },
      body: { parts: [{ type: "text", text }] },
    });

    pollSessionCompletion(sessionData.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try { await sendToSlack(channel, `❌ 오류: ${msg}`, ts); } catch {}
  }
}

async function pollSessionCompletion(sessionID: string): Promise<void> {
  const meta = activeSessions.get(sessionID);
  if (!meta) return;

  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 2000));

    try {
      const messagesResult = await client.session.messages({ path: { id: sessionID } });
      const messages = (messagesResult.data || []) as Array<{ info: { role: string; time: { completed?: number } }; parts: Array<{ type: string; text?: string }> }>;

      const lastAssistant = [...messages].reverse().find(m => m.info.role === "assistant");
      if (!lastAssistant?.info.time.completed) continue;

      const textParts = lastAssistant.parts
        .filter(p => p.type === "text" && p.text)
        .map(p => p.text!)
        .join("\n");

      if (textParts) {
        await sendToSlack(meta.channel, textParts);
      }

      try { await slack.reactions.add({ channel: meta.channel, name: "white_check_mark", timestamp: meta.ts }); } catch {}
      activeSessions.delete(sessionID);
      return;
    } catch {
    }
  }

  await sendToSlack(meta.channel, "⏱️ 타임아웃 (4분)", meta.ts);
  activeSessions.delete(sessionID);
}

const plugin = {
  id: "opencode-slack-agent",
  setup: async (ctx: { options: Record<string, unknown> }) => {
    const botToken = (ctx.options.SLACK_BOT_TOKEN as string) || process.env.SLACK_BOT_TOKEN;
    const appToken = (ctx.options.SLACK_APP_TOKEN as string) || process.env.SLACK_APP_TOKEN;
    const caCerts = (ctx.options.NODE_EXTRA_CA_CERTS as string) || process.env.NODE_EXTRA_CA_CERTS;

    if (caCerts && !process.env.NODE_EXTRA_CA_CERTS) {
      process.env.NODE_EXTRA_CA_CERTS = caCerts;
    }

    if (!botToken || !appToken) {
      console.error("[slack-agent] SLACK_BOT_TOKEN and SLACK_APP_TOKEN required — plugin disabled");
      return;
    }

    const port = parsePortFromArgv() || process.env.OPENCODE_PORT || "4096";
    const password = process.env.OPENCODE_SERVER_PASSWORD || "";
    const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
    client = createOpencodeClient({
      baseUrl: `http://127.0.0.1:${port}`,
      auth: password ? { type: "basic", username, password } : undefined,
    } as Parameters<typeof createOpencodeClient>[0]);

    slack = new WebClient(botToken);
    socketClient = new SocketModeClient({ appToken });

    await resolveBotUserId();
    console.error(`[slack-agent] Bot connected (user: ${botUserId})`);

    socketClient.on("message", async ({ event, ack }) => {
      await ack();
      const ev = event as SlackEvent;
      if (ev.bot_id || ev.user === botUserId) return;
      if (ev.subtype && ev.subtype !== "file_share") return;
      if (!ev.channel || !ev.text || !ev.ts) return;

      await handleMessage(ev.channel, ev.text, ev.ts);
    });

    socketClient.on("app_mention", async ({ event, ack }) => {
      await ack();
      const ev = event as SlackEvent;
      if (ev.user === botUserId) return;
      if (!ev.channel || !ev.text || !ev.ts) return;

      const text = ev.text.replace(/<@[A-Z0-9]+>/g, "").trim();
      if (!text) {
        await sendToSlack(ev.channel, "무엇을 도와드릴까요?", ev.ts);
        return;
      }

      await handleMessage(ev.channel, text, ev.ts);
    });

    socketClient.on("connected", () => {
      console.error("[slack-agent] Socket Mode connected");
    });

    socketClient.on("disconnected", () => {
      console.error("[slack-agent] Socket Mode disconnected — will auto-reconnect");
    });

    await socketClient.start();
    console.error("[slack-agent] Plugin initialized");
  },
};

export default plugin;
