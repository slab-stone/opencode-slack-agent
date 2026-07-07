import type { PluginModule, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { spawn, type ChildProcess } from "child_process";
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const LOG_FILE = "/tmp/slack-agent-plugin.log";
const SLACK_MSG_LIMIT = 3900;

let initialized = false;
let worker: ChildProcess | null = null;
let pluginClient: PluginInput["client"] | null = null;
let modelOverride: { providerID: string; modelID: string } | null = null;
let sessionsPath: string = "";
let sessions: Record<string, { sessionId: string; channel: string; lastUsed: number; directory?: string }> = {};
let defaultDirectory: string = "";

function log(m: string) {
  try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] plugin: ${m}\n`); } catch {}
}

function loadSessions() {
  try {
    if (existsSync(sessionsPath)) {
      sessions = JSON.parse(readFileSync(sessionsPath, "utf8"));
    }
  } catch { sessions = {}; }
}

function saveSessions() {
  try { writeFileSync(sessionsPath, JSON.stringify(sessions, null, 2)); } catch {}
}

function getSessionForThread(threadTs: string): string | null {
  const entry = sessions[threadTs];
  if (entry) {
    entry.lastUsed = Date.now();
    saveSessions();
    return entry.sessionId;
  }
  return null;
}

function saveSession(threadTs: string, sessionId: string, channel: string, directory?: string) {
  sessions[threadTs] = { sessionId, channel, lastUsed: Date.now(), ...(directory ? { directory } : {}) };
  saveSessions();
}

function sendIPC(msg: any) {
  if (worker && worker.connected) worker.send(msg);
}

function slackSend(channel: string, text: string, threadTs?: string) {
  sendIPC({ type: "slack_send", channel, text, threadTs });
}

function slackUpdate(channel: string, ts: string, text: string) {
  sendIPC({ type: "slack_update", channel, ts, text });
}

async function handleMessage(channel: string, text: string, ts: string) {
  if (!pluginClient) return;
  log(`handleMessage: ${text.slice(0, 50)}`);

  if (text.startsWith("!")) {
    const handled = await handleCommand(channel, text, ts);
    if (handled) return;
  }

  try {
    const threadTs = ts;
    let sessionId = getSessionForThread(threadTs);

    sendIPC({ type: "slack_reaction", channel, name: "peperun", timestamp: ts });

    if (!sessionId) {
      const directory = sessions[threadTs]?.directory || defaultDirectory;
      const { data: session } = await pluginClient.session.create({
        body: { title: `Slack: ${text.slice(0, 50)}` },
        query: directory ? { directory } : undefined,
      });
      if (!session?.id) {
        slackSend(channel, "❌ 세션 생성 실패", threadTs);
        return;
      }
      sessionId = session.id;
      saveSession(threadTs, sessionId, channel, directory);
      log(`new session: ${sessionId} for thread ${threadTs} (dir: ${directory || "default"})`);
    } else {
      log(`existing session: ${sessionId} for thread ${threadTs}`);
    }

    const promptBody: any = {
      parts: [{ type: "text" as const, text }],
    };
    if (modelOverride) promptBody.model = modelOverride;

    await pluginClient.session.promptAsync({
      path: { id: sessionId },
      body: promptBody,
    });
    log("prompt sent");

    let streamMsgTs: string | null = null;
    let lastToolSeen = 0;

    for (let i = 0; i < 180; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const { data: messages } = await pluginClient.session.messages({
          path: { id: sessionId },
        });
        if (!Array.isArray(messages)) continue;
        const lastAssistant = [...messages].reverse().find(
          (m: any) => m.info?.role === "assistant"
        );
        if (!lastAssistant) continue;

        const parts = lastAssistant.parts as any[];

        const activeParts = parts.filter((p: any) =>
          p.type === "reasoning" ||
          (p.type === "tool" && (p.state?.status === "running" || p.state?.status === "completed"))
        );
        if (activeParts.length > lastToolSeen) {
          lastToolSeen = activeParts.length;
          const latest = activeParts[activeParts.length - 1];
          let statusText = "";
          if (latest.type === "reasoning" && latest.text) {
            const snippet = latest.text.length > 200 ? latest.text.slice(0, 200) + "…" : latest.text;
            statusText = `💭 ${snippet}`;
          } else if (latest.type === "tool") {
            const title = latest.state?.title || latest.tool || "";
            if (title) statusText = `🔧 _${title}_`;
          }
          if (statusText) {
            if (streamMsgTs) {
              slackUpdate(channel, streamMsgTs, statusText);
            } else {
              slackSend(channel, statusText, threadTs);
            }
          }
        }

        if (!lastAssistant.info?.time?.completed) continue;

        const textParts = parts
          .filter((p: any) => p.type === "text" && p.text)
          .map((p: any) => p.text)
          .join("\n");

        if (textParts) {
          sendLongText(channel, textParts, threadTs);
        }
        sendIPC({ type: "slack_reaction_remove", channel, name: "peperun", timestamp: ts });
        log(`session ${sessionId} completed`);
        return;
      } catch (pollErr: any) {
        log(`poll error: ${pollErr.message}`);
      }
    }
    slackSend(channel, "⏱️ 타임아웃 (6분)", threadTs);
  } catch (e: any) {
    log(`error: ${e.message}`);
    slackSend(channel, `❌ 오류: ${e.message}`, ts);
  }
}

function splitText(text: string): string[] {
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
  return chunks;
}

function sendLongText(channel: string, text: string, threadTs?: string) {
  if (text.length <= SLACK_MSG_LIMIT) {
    slackSend(channel, text, threadTs);
    return;
  }
  const chunks = splitText(text);
  for (let i = 0; i < chunks.length; i++) {
    const prefix = chunks.length > 1 ? `_(${i + 1}/${chunks.length})_\n` : "";
    slackSend(channel, prefix + chunks[i], threadTs);
  }
}

async function handleCommand(channel: string, text: string, ts: string): Promise<boolean> {
  if (!pluginClient) return false;
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();

  if (cmd === "!model") {
    const arg = parts.slice(1).join(" ").trim();
    if (!arg) {
      const current = modelOverride
        ? `${modelOverride.providerID}/${modelOverride.modelID}`
        : "(default)";
      const lines = [`*현재 모델:* \`${current}\``, "", "*사용 가능:*"];
      try {
        const { data: config } = await pluginClient.config.get();
        if (config?.provider) {
          for (const [provId, prov] of Object.entries(config.provider as Record<string, any>)) {
            for (const modelId of Object.keys(prov.models || {})) {
              lines.push(`• \`${provId}/${modelId}\``);
            }
          }
        }
      } catch {
        lines.push("_(모델 목록을 가져올 수 없습니다)_");
      }
      slackSend(channel, lines.join("\n"), ts);
      return true;
    }
    if (arg === "reset" || arg === "default") {
      modelOverride = null;
      slackSend(channel, "✅ 기본 모델로 복원", ts);
      return true;
    }
    const match = arg.match(/^([^/]+)\/(.+)$/);
    if (match) {
      modelOverride = { providerID: match[1], modelID: match[2] };
      slackSend(channel, `✅ 모델 변경: \`${arg}\``, ts);
    } else {
      slackSend(channel, `❌ 형식: \`!model provider/model\` (예: \`!model kiro/claude-sonnet-4-6\`)`, ts);
    }
    return true;
  }

  if (cmd === "!reset") {
    delete sessions[ts];
    saveSessions();
    slackSend(channel, "✅ 세션 리셋됨. 다음 메시지부터 새 세션.", ts);
    return true;
  }

  if (cmd === "!dir") {
    const arg = parts.slice(1).join(" ").trim();
    if (!arg) {
      const currentDir = sessions[ts]?.directory || defaultDirectory || "(기본)";
      slackSend(channel, `*현재 워크스페이스:* \`${currentDir}\``, ts);
      return true;
    }
    if (!sessions[ts]) {
      sessions[ts] = { sessionId: "", channel, lastUsed: Date.now(), directory: arg };
    } else {
      sessions[ts].directory = arg;
    }
    saveSessions();
    slackSend(channel, `✅ 워크스페이스 변경: \`${arg}\`\n다음 메시지부터 이 디렉토리에서 세션 생성.`, ts);
    return true;
  }

  if (cmd === "!attach") {
    const arg = parts.slice(1).join(" ").trim();
    if (!arg) {
      const currentSession = sessions[ts]?.sessionId || "(없음)";
      slackSend(channel, `*현재 세션:* \`${currentSession}\``, ts);
      return true;
    }
    let sessionId = arg;
    const urlMatch = arg.match(/\/session\/(ses_[a-zA-Z0-9]+)/);
    if (urlMatch) {
      sessionId = urlMatch[1];
    }
    if (!sessionId.startsWith("ses_")) {
      slackSend(channel, `❌ 형식: \`!attach ses_xxx\` 또는 OpenCode URL 붙여넣기`, ts);
      return true;
    }
    saveSession(ts, sessionId, channel, sessions[ts]?.directory);
    slackSend(channel, `✅ 세션 연결: \`${sessionId}\`\n이 스레드의 메시지가 해당 세션으로 전달됩니다.`, ts);
    return true;
  }

  if (cmd === "!help") {
    const help = [
      "*사용 가능한 명령:*",
      "• `!model` — 현재 모델 확인 / 변경",
      "• `!model provider/model` — 모델 변경",
      "• `!model reset` — 기본 모델 복원",
      "• `!dir` — 현재 워크스페이스 확인",
      "• `!dir /path/to/project` — 워크스페이스 변경",
      "• `!attach ses_xxx` — 기존 세션 연결 (URL 붙여넣기 가능)",
      "• `!reset` — 현재 스레드 세션 리셋",
      "• `!help` — 이 도움말",
    ];
    slackSend(channel, help.join("\n"), ts);
    return true;
  }

  return false;
}

function startWorker(env: Record<string, string>) {
  const workerPath = join(dirname(fileURLToPath(import.meta.url)), "socket-worker.js");
  log(`starting worker: ${workerPath}`);

  worker = spawn("node", [workerPath], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    detached: false,
  });

  worker.on("message", (msg: any) => {
    if (msg?.type === "slack_event") {
      handleMessage(msg.channel, msg.text, msg.threadTs);
    }
  });

  worker.on("exit", (code) => {
    log(`worker exited: code=${code}`);
    worker = null;
    if (initialized) {
      setTimeout(() => { log("restarting worker..."); startWorker(env); }, 5000);
    }
  });

  log("worker spawned");
}

function stopWorker() {
  if (worker) {
    worker.removeAllListeners();
    worker.kill("SIGTERM");
    worker = null;
  }
  log("worker stopped");
}

const slackStatusTool = tool({
  description: "Slack 에이전트 상태 확인",
  args: {},
  async execute() {
    const status = worker && !worker.killed ? "running" : "stopped";
    const sessionCount = Object.keys(sessions).length;
    return { output: `Slack agent: ${status}, sessions: ${sessionCount}` };
  },
});

const pluginModule: PluginModule = {
  id: "opencode-slack-agent",
  server: async (input: PluginInput, options?: PluginOptions) => {
    log("server() called");
    if (initialized) return { tool: { slack_status: slackStatusTool } };

    const botToken = (options?.SLACK_BOT_TOKEN as string) || process.env.SLACK_BOT_TOKEN || "";
    const appToken = (options?.SLACK_APP_TOKEN as string) || process.env.SLACK_APP_TOKEN || "";

    const enabled = process.env.SLACK_AGENT_ENABLED
      ?? (options?.SLACK_AGENT_ENABLED as string)
      ?? "true";
    if (enabled === "false" || enabled === "0") {
      log("DISABLED — SLACK_AGENT_ENABLED=false");
      initialized = true;
      return { tool: { slack_status: slackStatusTool } };
    }

    if (!botToken || !appToken) {
      log("DISABLED — missing tokens");
      initialized = true;
      return { tool: { slack_status: slackStatusTool } };
    }

    pluginClient = input.client;
    defaultDirectory = (options?.DEFAULT_DIRECTORY as string) || process.env.SLACK_DEFAULT_DIRECTORY || input.directory;
    sessionsPath = join(input.directory, "slack-sessions.json");
    loadSessions();
    log(`sessions loaded: ${Object.keys(sessions).length} entries from ${sessionsPath}`);

    const workerEnv: Record<string, string> = {
      SLACK_BOT_TOKEN: botToken,
      SLACK_APP_TOKEN: appToken,
    };
    const caCerts = (options?.NODE_EXTRA_CA_CERTS as string) || process.env.NODE_EXTRA_CA_CERTS || "";
    if (caCerts) workerEnv.NODE_EXTRA_CA_CERTS = caCerts;

    startWorker(workerEnv);
    initialized = true;
    log("plugin initialized (hybrid sidecar + persistent sessions)");

    return {
      tool: { slack_status: slackStatusTool },
      dispose: async () => {
        stopWorker();
        pluginClient = null;
        initialized = false;
        log("shutdown");
      },
    };
  },
};

export default pluginModule;
