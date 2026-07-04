// @bun
var __require = import.meta.require;

// src/plugin.ts
import { spawn } from "child_process";
import { appendFileSync, existsSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
var LOG = "/tmp/slack-agent-plugin.log";
var LOCK = "/tmp/slack-agent.lock";
var log = (m) => {
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] plugin: ${m}
`);
  } catch {}
};
log("module top-level");
function parsePortFromArgv() {
  const idx = process.argv.indexOf("--port");
  if (idx !== -1 && process.argv[idx + 1])
    return process.argv[idx + 1];
  return;
}
var worker = null;
var initialized = false;
function startWorker(env) {
  const workerPath = join(dirname(fileURLToPath(import.meta.url)), "socket-worker.js");
  log(`starting worker: ${workerPath}`);
  worker = spawn("node", [workerPath], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "ignore"],
    detached: false
  });
  worker.on("exit", (code) => {
    log(`worker exited: code=${code}`);
    worker = null;
    if (existsSync(LOCK)) {
      setTimeout(() => {
        log("restarting worker...");
        startWorker(env);
      }, 5000);
    }
  });
  log("worker spawned");
}
var slackStatusTool = {
  description: "Slack \uC5D0\uC774\uC804\uD2B8 \uC0C1\uD0DC \uD655\uC778",
  parameters: { type: "object", properties: {} },
  execute: async () => {
    const status = worker && !worker.killed ? "running" : "stopped";
    return { content: [{ type: "text", text: `Slack agent: ${status}` }] };
  }
};
var pluginModule = {
  id: "opencode-slack-agent",
  server: async (_input, options) => {
    log("server() called");
    if (initialized)
      return { tool: { slack_status: slackStatusTool } };
    if (existsSync(LOCK)) {
      log("another instance running, skipping");
      initialized = true;
      return { tool: { slack_status: slackStatusTool } };
    }
    writeFileSync(LOCK, String(process.pid));
    process.on("exit", () => {
      try {
        __require("fs").unlinkSync(LOCK);
      } catch {}
    });
    const botToken = options?.SLACK_BOT_TOKEN || process.env.SLACK_BOT_TOKEN || "";
    const appToken = options?.SLACK_APP_TOKEN || process.env.SLACK_APP_TOKEN || "";
    const caCerts = options?.NODE_EXTRA_CA_CERTS || process.env.NODE_EXTRA_CA_CERTS || "";
    if (!botToken || !appToken) {
      log("DISABLED \u2014 missing tokens");
      initialized = true;
      return { tool: { slack_status: slackStatusTool } };
    }
    const port = parsePortFromArgv() || process.env.OPENCODE_PORT || "4096";
    const password = process.env.OPENCODE_SERVER_PASSWORD || "";
    const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
    const baseUrl = `http://127.0.0.1:${port}`;
    const authHeader = password ? `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` : "";
    const workerEnv = {
      SLACK_BOT_TOKEN: botToken,
      SLACK_APP_TOKEN: appToken,
      OPENCODE_BASE_URL: baseUrl,
      OPENCODE_AUTH_HEADER: authHeader
    };
    if (caCerts)
      workerEnv.NODE_EXTRA_CA_CERTS = caCerts;
    startWorker(workerEnv);
    initialized = true;
    log(`plugin initialized (port=${port})`);
    return {
      tool: { slack_status: slackStatusTool },
      dispose: async () => {
        if (worker) {
          worker.kill();
          worker = null;
        }
        try {
          __require("fs").unlinkSync(LOCK);
        } catch {}
        log("shutdown");
      }
    };
  }
};
var plugin_default = pluginModule;
export {
  plugin_default as default
};
