# opencode-slack-agent

OpenCode plugin that connects Slack to your AI agent. Receives DMs and @mentions via Socket Mode, creates OpenCode sessions to process them, and sends responses back to Slack.

## How It Works

```
opencode serve
  └─ [plugin: opencode-slack-agent]
       └─ spawns Node worker process
            ├─ Socket Mode (real-time Slack events)
            ├─ DM or @mention received
            │    └─ Creates OpenCode session via HTTP API → AI processes
            └─ Sends response back to Slack
```

## Setup

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Enable **Socket Mode** → generate App-Level Token (`xapp-...`) with scope `connections:write`
3. Add **Bot Token Scopes** (OAuth & Permissions):
   - `im:read`, `im:write`, `im:history`, `channels:read`, `chat:write`
   - `reactions:write`, `reactions:read`, `files:read`, `files:write`
4. Add **Event Subscriptions** (Subscribe to bot events):
   - `message.im`, `app_mention`, `reaction_added`
5. **Install to Workspace** → save Bot Token (`xoxb-...`)

### 2. Install the Plugin

```bash
opencode plugin opencode-slack-agent --global
```

### 3. Configure

Add plugin with tokens to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    ["opencode-slack-agent", {
      "SLACK_BOT_TOKEN": "xoxb-...",
      "SLACK_APP_TOKEN": "xapp-..."
    }]
  ]
}
```

Port and auth are auto-detected from the serve process. Only Slack tokens are required.

### 4. Run

```bash
opencode serve --port 4096
```

The plugin loads automatically and spawns a Node worker process for Socket Mode. Send a DM to your bot or @mention it in any channel.

## Behavior

- **DM**: Bot responds to all direct messages
- **@mention**: Bot responds when mentioned in channels
- **Progress**: Shows 👀 reaction on receipt, sends "처리 중..." in thread, ✅ on completion
- **Final result**: Sent as channel message
- **Long messages**: Auto-split into chunks
- **Auto-restart**: Worker restarts automatically if it crashes

## Architecture

The plugin uses a sidecar pattern:

1. **Plugin** (runs in OpenCode's embedded Bun) — spawns and monitors the worker
2. **Worker** (runs as independent Node.js process) — handles Socket Mode + OpenCode API

This separation is necessary because OpenCode's embedded Bun runtime doesn't reliably deliver WebSocket events. The worker communicates with OpenCode via its HTTP API.

## Important

- Only **one** Socket Mode connection should exist per app token at a time
- If running OpenCode.app and CLI serve simultaneously, only one should have the plugin active
- App-Level Token rotation may be needed if stale connections cause event delivery issues

## Development

```bash
git clone https://github.com/leecoder/opencode-slack-agent.git
cd opencode-slack-agent
npm install
bun build src/plugin.ts --target=bun --outdir=dist --format=esm --external=child_process --external=fs --external=path --external=url
bun build src/socket-worker.mjs --target=node --outdir=dist --format=esm
```

## License

MIT
