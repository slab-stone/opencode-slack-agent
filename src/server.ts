import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { resolveBotUserId, getBotUserId, slack } from "./slack-client.js";
import { closeDb } from "./db.js";
import { SLACK_DEFAULT_CHANNEL } from "./types.js";
import { startSocketMode, stopSocketMode } from "./socket.js";

import { registerBasicTools } from "./tools/basic.js";
import { registerLoopTools } from "./tools/loop.js";

const server = new McpServer({
  name: "opencode-slack-agent",
  version: "1.0.0",
}, {
  capabilities: { tools: {} },
});

registerBasicTools(server);
registerLoopTools(server);

async function main() {
  await resolveBotUserId();
  const botId = getBotUserId();
  if (botId) {
    console.error(`🤖 Slack Bot connected (user: ${botId})`);
  } else {
    console.error("⚠️ Could not resolve bot user ID — check SLACK_BOT_TOKEN");
  }

  await startSocketMode();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🚀 OpenCode Slack MCP Server running on stdio");

  const shutdown = async (signal: string) => {
    console.error(`\n⚡ ${signal} received — graceful shutdown...`);
    await stopSocketMode();

    try {
      if (SLACK_DEFAULT_CHANNEL) {
        await slack.chat.postMessage({
          channel: SLACK_DEFAULT_CHANNEL,
          text: `🔄 *OpenCode Slack Agent 종료 중* (${signal})...`,
          mrkdwn: true,
        });
      }
    } catch { /* best effort */ }

    closeDb();
    console.error("👋 Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
