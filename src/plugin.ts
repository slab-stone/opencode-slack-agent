import type { PluginModule, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { spawn, type ChildProcess } from "child_process";
import { appendFileSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const LOG_FILE = "/tmp/slack-agent-plugin.log";
const SLACK_MSG_LIMIT = 3900;

let initialized = false;
let worker: ChildProcess | null = null;
let pluginClient: PluginInput["client"] | null = null;
let modelOverride: { providerID: string; modelID: string } | null = null;

function log(m: string) {
  try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] plugin: ${m}\n`); } catch {}
}

async function sendToSlack(channel: string, text: string, threadTs?: string) {
  if (!worker) return;
  const msg = { type: "slack_send", channel, text, threadTs };
  worker.send(msg);
}

async function addReaction(channel: string, name: string, timestamp: string) {
  if (!worker) return;
  worker.send({ type: "slack_reaction", channel, name, timestamp });
}

async function handleMessage(channel: string, text: string, ts: string) {
  if (!pluginClient) return;
  log(`handleMessage: ${text.slice(0, 50)}`);

  if (text.startsWith("!")) {
    const handled = await handleCommand(channel, text, ts);
    if (handled) return;
  }

  await addReaction(channel, "eyes", ts);
  await sendToSlack(channel, "🔍 처리 중...", ts);

  try {
    const { data: session } = await pluginClient.session.create({
      body: { title: `Slack: ${text.slice(0, 50)}` },
    });
    if (!session?.id) {
      await sendToSlack(channel, "❌ 세션 생성 실패", ts);
      return;
    }
    log(`session: ${session.id}`);

    const promptBody: any = {
      parts: [{ type: "text" as const, text }],
    };
    if (modelOverride) promptBody.model = modelOverride;

    await pluginClient.session.promptAsync({
      path: { id: session.id },
      body: promptBody,
    });
    log("prompt sent");

    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const { data: messages } = await pluginClient.session.messages({
          path: { id: session.id },
        });
        if (!Array.isArray(messages)) continue;
        const lastAssistant = [...messages].reverse().find(
          (m: any) => m.info?.role === "assistant"
        );
        if (!lastAssistant?.info?.time?.completed) continue;

        const textParts = (lastAssistant.parts as any[])
          .filter((p: any) => p.type === "text" && p.text)
          .map((p: any) => p.text)
          .join("\n");

        if (textParts) await sendToSlack(channel, textParts, ts);
        await addReaction(channel, "white_check_mark", ts);
        log(`session ${session.id} completed`);
        return;
      } catch (pollErr: any) {
        log(`poll error: ${pollErr.message}`);
      }
    }
    await sendToSlack(channel, "⏱️ 타임아웃 (4분)", ts);
  } catch (e: any) {
    log(`error: ${e.message}`);
    await sendToSlack(channel, `❌ 오류: ${e.message}`, ts);
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
      await sendToSlack(channel, lines.join("\n"), ts);
      return true;
    }
    if (arg === "reset" || arg === "default") {
      modelOverride = null;
      await sendToSlack(channel, "✅ 기본 모델로 복원", ts);
      return true;
    }
    const match = arg.match(/^([^/]+)\/(.+)$/);
    if (match) {
      modelOverride = { providerID: match[1], modelID: match[2] };
      await sendToSlack(channel, `✅ 모델 변경: \`${arg}\``, ts);
    } else {
      await sendToSlack(channel, `❌ 형식: \`!model provider/model\` (예: \`!model kiro/claude-sonnet-4-6\`)`, ts);
    }
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
      handleMessage(msg.channel, msg.text, msg.ts);
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
    return { output: `Slack agent: ${status}` };
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

    const workerEnv: Record<string, string> = {
      SLACK_BOT_TOKEN: botToken,
      SLACK_APP_TOKEN: appToken,
    };
    const caCerts = (options?.NODE_EXTRA_CA_CERTS as string) || process.env.NODE_EXTRA_CA_CERTS || "";
    if (caCerts) workerEnv.NODE_EXTRA_CA_CERTS = caCerts;

    startWorker(workerEnv);
    initialized = true;
    log("plugin initialized (hybrid sidecar)");

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
