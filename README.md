# opencode-slack-agent

Slack MCP server for [OpenCode](https://github.com/nicepkg/opencode) — enables AI agents to receive commands via Slack DM or @mention and respond using the full OpenCode toolchain.

## Features

- **Socket Mode** — Real-time event reception via WebSocket, no polling or public endpoints
- **Mention mode** — Respond to @mentions in any channel (default)
- **DM mode** — Direct message conversation with the bot
- **Channel mode** — Lock to a specific channel for focused operation
- **Thread-based progress** — Intermediate steps go to threads, final results to channel
- **Flexible channel resolution** — Accepts channel ID, #name, Slack URL, or user ID
- **SQLite inbox** — Persistent message queue with WAL mode for multiprocess safety
- **Auto-split long messages** — Messages over 4000 chars are chunked or uploaded as file
- **Reaction commands** — Users can respond with emoji (✅ approve, ❌ reject, 🚀 proceed, etc.)

## Architecture

```
┌─────────────────────────────────────────────────┐
│  OpenCode Agent (skill: /slack-loop)            │
│  ┌───────────────────────────────────────────┐  │
│  │  MCP Client (skill_mcp)                   │  │
│  └──────────────────┬────────────────────────┘  │
│                     │ stdio                      │
│  ┌──────────────────▼────────────────────────┐  │
│  │  opencode-slack-agent (MCP Server)        │  │
│  │  ├── Socket Mode (real-time events)       │  │
│  │  ├── SQLite inbox (message queue)         │  │
│  │  └── Slack Web API (send/react/read)      │  │
│  └──────────────────┬────────────────────────┘  │
└─────────────────────│───────────────────────────┘
                      │ WebSocket + HTTPS
                ┌─────▼─────┐
                │   Slack   │
                └───────────┘
```

## Tools (10)

| Tool | Description |
|------|-------------|
| `slack_command_loop` | Block-wait for next user command (30s cycles) |
| `slack_check_inbox` | Non-blocking inbox check |
| `slack_resolve_channel` | Resolve channel ID/name/URL → channel ID |
| `slack_send_message` | Send message to channel |
| `slack_respond` | Reply to user (auto-routes thread vs channel) |
| `slack_reply_thread` | Reply in a specific thread |
| `slack_read_messages` | Read recent channel messages |
| `slack_get_thread` | Read full thread |
| `slack_add_reaction` | Add emoji reaction |
| `slack_list_channels` | List accessible channels |

## Setup

### Prerequisites

- Node.js 18+
- A Slack App with Socket Mode enabled
- Bot token scopes: `im:read`, `im:write`, `channels:read`, `reactions:write`, `reactions:read`, `files:read`, `files:write`, `chat:write`
- Event subscriptions: `message.im`, `app_mention`, `reaction_added`

### Installation

```bash
git clone https://github.com/leecoder/opencode-slack-agent.git
cd opencode-slack-agent
npm install
npm run build
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | Yes | Bot user OAuth token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | Yes | App-level token for Socket Mode (`xapp-...`) |
| `SLACK_DEFAULT_CHANNEL` | No | Default channel ID (fallback when no channel specified) |
| `NODE_EXTRA_CA_CERTS` | No | Path to CA certificate bundle (for corporate proxies) |

### OpenCode Skill Setup

1. Create the skill directory:

```bash
mkdir -p ~/.config/opencode/skills/slack-agent
```

2. Create `mcp.json`:

```json
{
  "mcpServers": {
    "slack-agent": {
      "command": "/path/to/opencode-slack-agent/run.sh",
      "args": []
    }
  }
}
```

3. Create `run.sh`:

```bash
#!/bin/bash
export SLACK_BOT_TOKEN="xoxb-..."
export SLACK_APP_TOKEN="xapp-..."
export NODE_EXTRA_CA_CERTS="/path/to/ca-certificates.pem"  # optional
exec node /path/to/opencode-slack-agent/dist/index.js
```

```bash
chmod +x run.sh
```

4. Copy `SKILL.md` from this repository to the skill directory.

## Usage

### Mention mode (default — responds to @mentions in any channel + DMs)

```bash
opencode run "/slack-loop"
```

### Channel-specific mode

```bash
opencode run "/slack-loop D0BC8PB3D6Y"
opencode run "/slack-loop #general"
opencode run "/slack-loop https://workspace.slack.com/archives/C01234ABCDE"
```

### With server mode (persistent, no timeout)

```bash
# Start server
opencode serve --port 4096

# Attach slack-loop to the server
opencode run "/slack-loop" --attach http://localhost:4096
```

## Development

```bash
npm run dev    # Run with tsx (hot reload)
npm run build  # Compile TypeScript
npm start      # Run compiled output
```

## License

MIT
