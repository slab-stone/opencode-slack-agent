# opencode-slack-agent

OpenCode plugin that connects Slack to your AI agent. Receives DMs and @mentions via Socket Mode, creates OpenCode sessions to process them, and sends responses back to Slack.

## How It Works

```
opencode serve
  └─ [plugin: opencode-slack-agent]
       ├─ Socket Mode (real-time Slack events)
       ├─ DM or @mention received
       │    └─ Creates new OpenCode session → AI processes → Response sent to Slack
       └─ Runs as long as opencode serve is alive (no timeout)
```

## Setup

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Enable **Socket Mode** → generate App-Level Token (`xapp-...`) with scope `connections:write`
3. Add **Bot Token Scopes** (OAuth & Permissions):
   - `im:read`, `im:write`, `channels:read`, `chat:write`
   - `reactions:write`, `reactions:read`, `files:read`, `files:write`
4. Add **Event Subscriptions** (Subscribe to bot events):
   - `message.im`, `app_mention`, `reaction_added`
5. **Install to Workspace** → save Bot Token (`xoxb-...`)

### 2. Install the Plugin

```bash
opencode plugin github:leecoder/opencode-slack-agent --global
```

Or add manually to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    "opencode-slack-agent"
  ]
}
```

### 3. Configure

Add plugin with tokens to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    ["opencode-slack-agent", {
      "SLACK_BOT_TOKEN": "xoxb-...",
      "SLACK_APP_TOKEN": "xapp-...",
      "OPENCODE_PORT": "4096"
    }]
  ]
}
```

Optional settings in the options object:

| Key | Required | Description |
|-----|----------|-------------|
| `SLACK_BOT_TOKEN` | Yes | Bot user OAuth token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | Yes | App-level token for Socket Mode (`xapp-...`) |
| `OPENCODE_PORT` | Yes | Port that `opencode serve` listens on |
| `NODE_EXTRA_CA_CERTS` | No | CA certificate bundle (corporate proxy) |

### 4. Run

```bash
opencode serve --port 4096
```

The plugin loads automatically. Send a DM to your bot or @mention it in any channel.

## Behavior

- **DM**: Bot responds to all direct messages
- **@mention**: Bot responds when mentioned in channels (strips the mention prefix)
- **Progress**: Shows 👀 reaction on receipt, ✅ on completion
- **Long messages**: Auto-split into chunks or uploaded as file

## Environment Variables

All settings can be provided via `opencode.json` plugin options (recommended) or environment variables as fallback.

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Bot user OAuth token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | App-level token for Socket Mode (`xapp-...`) |
| `OPENCODE_PORT` | Port that `opencode serve` listens on |
| `OPENCODE_SERVER_PASSWORD` | Basic auth password (if serve requires auth) |
| `NODE_EXTRA_CA_CERTS` | CA certificate bundle (corporate proxy) |

## Development

```bash
git clone https://github.com/leecoder/opencode-slack-agent.git
cd opencode-slack-agent
npm install
npm run build

# Register as local plugin
opencode plugin /path/to/opencode-slack-agent --global --force
```

## Architecture

The plugin uses OpenCode's v2 plugin API (`{id, setup}` format):

1. `setup()` starts a Slack Socket Mode connection
2. On DM/@mention → calls `session.create()` + `session.promptAsync()` via OpenCode SDK
3. Polls session until assistant response is complete
4. Sends response back to Slack

Since the plugin runs inside the `opencode serve` process, there's no idle timeout — it stays alive as long as serve runs.

## License

MIT
