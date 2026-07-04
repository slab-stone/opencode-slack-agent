import type { PluginModule, ToolDefinition } from "@opencode-ai/plugin";
import { spawn, type ChildProcess } from "child_process";
import { appendFileSync, existsSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const LOG = "/tmp/slack-agent-plugin.log";
const LOCK = "/tmp/slack-agent.lock";
const log = (m: string) => { try { appendFileSync(LOG, `[${new Date().toISOString()}] plugin: ${m}\n`); } catch {} };

log("module top-level");

function parsePortFromArgv(): string | undefined {
  const idx = process.argv.indexOf("--port");
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}

let worker: ChildProcess | null = null;
let initialized = false;

function startWorker(env: Record<string, string>) {
  const workerPath = join(dirname(fileURLToPath(import.meta.url)), "socket-worker.js");
  log(`starting worker: ${workerPath}`);

  worker = spawn("node", [workerPath], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "ignore"],
    detached: false,
  });

  worker.on("exit", (code) => {
    log(`worker exited: code=${code}`);
    worker = null;
    if (existsSync(LOCK)) {
      setTimeout(() => { log("restarting worker..."); startWorker(env); }, 5000);
    }
  });

  log("worker spawned");
}

const slackStatusTool: ToolDefinition = {
  description: "Slack 에이전트 상태 확인",
  parameters: { type: "object" as const, properties: {} },
  execute: async () => {
    const status = worker && !worker.killed ? "running" : "stopped";
    return { content: [{ type: "text" as const, text: `Slack agent: ${status}` }] };
  },
};

const pluginModule: PluginModule = {
  id: "opencode-slack-agent",
  server: async (_input, options) => {
    log("server() called");
    if (initialized) return { tool: { slack_status: slackStatusTool } };

    if (existsSync(LOCK)) {
      log("another instance running, skipping");
      initialized = true;
      return { tool: { slack_status: slackStatusTool } };
    }
    writeFileSync(LOCK, String(process.pid));
    process.on("exit", () => { try { require("fs").unlinkSync(LOCK); } catch {} });

    const botToken = (options?.SLACK_BOT_TOKEN as string) || process.env.SLACK_BOT_TOKEN || "";
    const appToken = (options?.SLACK_APP_TOKEN as string) || process.env.SLACK_APP_TOKEN || "";
    const caCerts = (options?.NODE_EXTRA_CA_CERTS as string) || process.env.NODE_EXTRA_CA_CERTS || "";

    if (!botToken || !appToken) {
      log("DISABLED — missing tokens");
      initialized = true;
      return { tool: { slack_status: slackStatusTool } };
    }

    const port = parsePortFromArgv() || process.env.OPENCODE_PORT || "4096";
    const password = process.env.OPENCODE_SERVER_PASSWORD || "";
    const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
    const baseUrl = `http://127.0.0.1:${port}`;
    const authHeader = password ? `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` : "";

    const workerEnv: Record<string, string> = {
      SLACK_BOT_TOKEN: botToken,
      SLACK_APP_TOKEN: appToken,
      OPENCODE_BASE_URL: baseUrl,
      OPENCODE_AUTH_HEADER: authHeader,
    };
    if (caCerts) workerEnv.NODE_EXTRA_CA_CERTS = caCerts;

    startWorker(workerEnv);
    initialized = true;
    log(`plugin initialized (port=${port})`);

    return {
      tool: { slack_status: slackStatusTool },
      dispose: async () => {
        if (worker) { worker.kill(); worker = null; }
        try { require("fs").unlinkSync(LOCK); } catch {}
        log("shutdown");
      },
    };
  },
};

export default pluginModule;
