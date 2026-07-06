# opencode-slack-agent

OpenCode plugin that connects Slack to your AI agent. Receives DMs and @mentions via Socket Mode, creates OpenCode sessions to process them, and sends responses back to Slack.

## How It Works

```
opencode serve
  └─ [plugin: opencode-slack-agent]
       ├─ Socket Mode (real-time Slack events, in-process)
       ├─ DM or @mention received
       │    └─ Creates OpenCode session via plugin client → AI processes
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
   - `message.im`, `app_mention`
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

### 4. Run

```bash
opencode serve --port 4096
```

The plugin loads automatically and starts Socket Mode in-process. Send a DM to your bot or @mention it in any channel.

## Behavior

- **DM**: Bot responds to all direct messages
- **@mention**: Bot responds when mentioned in channels
- **Progress**: Shows 👀 reaction on receipt, sends "처리 중..." in thread, ✅ on completion
- **Long messages**: Auto-split into chunks
- **Commands**: `!model` to list/switch models

## Architecture

The plugin runs entirely in-process within OpenCode's runtime:

1. **Plugin** loads inside `opencode serve`
2. **Slack SDK** is bundled with tsup (noExternal) for Bun compatibility
3. **OpenCode client** is accessed directly via `PluginInput.client` (no HTTP hop)
4. **Socket Mode** WebSocket connection is managed within the plugin lifecycle

No external processes, no lock files, no zombie process issues.

## Important

- Only **one** Socket Mode connection should exist per app token at a time
- If running OpenCode.app and CLI serve simultaneously, only one should have the plugin active

## Development

```bash
git clone https://github.com/leecoder/opencode-slack-agent.git
cd opencode-slack-agent
npm install
npm run build
```

## License

MIT
