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

type PendingPermission = {
  permissionId: string;
  sessionId: string;
  threadTs: string;
  channel: string;
  createdAt: number;
};
let pendingPermissions: Map<string, PendingPermission> = new Map();

type PendingQuestion = {
  sessionId: string;
  threadTs: string;
  channel: string;
  createdAt: number;
};
let pendingQuestions: Map<string, PendingQuestion> = new Map();

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

function findPendingPermissionForThread(threadTs: string): PendingPermission | null {
  for (const [key, perm] of pendingPermissions) {
    if (perm.threadTs === threadTs) {
      if (Date.now() - perm.createdAt > 5 * 60 * 1000) {
        pendingPermissions.delete(key);
        return null;
      }
      return perm;
    }
  }
  return null;
}

async function handlePermissionReply(pending: PendingPermission, text: string, channel: string, threadTs: string) {
  if (!pluginClient) return;
  const trimmed = text.trim().toLowerCase();
  let reply: "once" | "always" | "reject" | null = null;
  if (["1", "y", "yes", "once"].includes(trimmed)) reply = "once";
  else if (["2", "always"].includes(trimmed)) reply = "always";
  else if (["3", "n", "no", "reject"].includes(trimmed)) reply = "reject";

  if (!reply) {
    slackSend(channel, "_잘못된 응답. 1/y/yes, 2/always, 3/n/no 로 답해주세요._", threadTs);
    return;
  }

  try {
    await pluginClient.postSessionIdPermissionsPermissionId({
      path: { id: pending.sessionId, permissionID: pending.permissionId },
      body: { response: reply },
    });
    pendingPermissions.delete(pending.permissionId);
    const label = reply === "reject" ? "거부" : `허용 (${reply})`;
    slackSend(channel, `_권한 ${label}_`, threadTs);
    log(`permission ${pending.permissionId} replied: ${reply}`);
  } catch (e: any) {
    pendingPermissions.delete(pending.permissionId);
    slackSend(channel, `_권한 응답 실패: ${e.message}_`, threadTs);
    log(`permission reply error: ${e.message}`);
  }
}

function findPendingQuestionForThread(threadTs: string): PendingQuestion | null {
  for (const [key, q] of pendingQuestions) {
    if (q.threadTs === threadTs) {
      if (Date.now() - q.createdAt > 5 * 60 * 1000) {
        pendingQuestions.delete(key);
        return null;
      }
      return q;
    }
  }
  return null;
}

async function handleQuestionReply(pending: PendingQuestion, text: string, channel: string, threadTs: string) {
  if (!pluginClient) return;
  try {
    await pluginClient.tui.control.response({
      body: text.trim(),
    });
    pendingQuestions.delete(threadTs);
    log(`question replied: ${text.slice(0, 50)}`);
  } catch (e: any) {
    pendingQuestions.delete(threadTs);
    slackSend(channel, `_응답 전달 실패: ${e.message}_`, threadTs);
    log(`question reply error: ${e.message}`);
  }
}

async function handleMessage(channel: string, text: string, ts: string, messageTs?: string) {
  if (!pluginClient) return;
  const actualTs = messageTs || ts;
  log(`handleMessage: ${text.slice(0, 50)}`);

  if (text.startsWith("!")) {
    const handled = await handleCommand(channel, text, ts);
    if (handled) return;
  }

  const pending = findPendingPermissionForThread(ts);
  if (pending) {
    await handlePermissionReply(pending, text, channel, ts);
    return;
  }

  const pendingQ = findPendingQuestionForThread(ts);
  if (pendingQ) {
    await handleQuestionReply(pendingQ, text, channel, ts);
    return;
  }

  try {
    const threadTs = ts;
    let sessionId = getSessionForThread(threadTs);

    sendIPC({ type: "slack_reaction", channel, name: "peperun", timestamp: actualTs });

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
    let questionPosted = false;

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

        const questionTool = parts.find((p: any) =>
          p.type === "tool" && p.tool === "question" && p.state?.status === "running"
        );
        if (questionTool && !questionPosted) {
          questionPosted = true;
          const input = questionTool.state?.input || {};
          const questions = input.questions || [];
          let msg = "❓ *질문*\n";
          for (const q of questions) {
            msg += `\n*${q.header || ""}*\n${q.question}\n`;
            if (q.options?.length) {
              q.options.forEach((opt: any, idx: number) => {
                msg += `  *${idx + 1}.* ${opt.label}${opt.description ? ` — ${opt.description}` : ""}\n`;
              });
            }
          }
          msg += "\n_번호 또는 텍스트로 답해주세요_";
          slackSend(channel, msg, threadTs);
          pendingQuestions.set(threadTs, {
            sessionId,
            threadTs,
            channel,
            createdAt: Date.now(),
          });
          log(`question forwarded to slack for thread ${threadTs}`);
          sendIPC({ type: "slack_reaction_remove", channel, name: "peperun", timestamp: actualTs });
          return;
        }

        const activeParts = parts.filter((p: any) =>
          p.type === "reasoning" ||
          (p.type === "tool" && p.tool !== "question" && (p.state?.status === "running" || p.state?.status === "completed"))
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
        sendIPC({ type: "slack_reaction_remove", channel, name: "peperun", timestamp: actualTs });
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
      handleMessage(msg.channel, msg.text, msg.threadTs, msg.messageTs);
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
      "permission.ask": async (input: any, output: any) => {
        const sessionEntry = Object.entries(sessions).find(
          ([_, s]) => s.sessionId === input.sessionID
        );
        if (!sessionEntry) return;
        const [threadTs, session] = sessionEntry;

        pendingPermissions.set(input.id, {
          permissionId: input.id,
          sessionId: input.sessionID,
          threadTs,
          channel: session.channel,
          createdAt: Date.now(),
        });

        let msg = "⚠️ *권한 요청*\n";
        msg += `\`${input.title}\`\n`;
        if (input.pattern) {
          const patterns = Array.isArray(input.pattern) ? input.pattern.join(", ") : input.pattern;
          msg += `패턴: \`${patterns}\`\n`;
        }
        msg += "\n*1.* 허용 (이번만)\n*2.* 항상 허용\n*3.* 거부\n";
        msg += "_1/y/yes, 2/always, 3/n/no 로 답해주세요_";

        slackSend(session.channel, msg, threadTs);
        log(`permission.ask forwarded to slack: ${input.id} (${input.title})`);

        output.status = "ask";
      },
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
