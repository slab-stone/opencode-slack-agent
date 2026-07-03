# OpenCode Slack Agent — 설정 가이드

## 1. opencode.json에 MCP 서버 등록

프로젝트의 `opencode.json` (또는 `~/.config/opencode/config.json`)에 추가:

```json
{
  "mcpServers": {
    "slack": {
      "command": "node",
      "args": ["/Users/YOU/work/opencode-slack-agent/dist/index.js"],
      "env": {
        "SLACK_BOT_TOKEN": "xoxb-your-bot-token",
        "SLACK_DEFAULT_CHANNEL": "C채널ID"
      }
    }
  }
}
```

## 2. Scheduled Job으로 자동 시작

OpenCode 시작 시 자동으로 Slack 루프를 시작하려면:

```
schedule_job(
  name: "slack-loop",
  schedule: "@startup",
  prompt: "/slack-loop"
)
```

또는 CLI에서:
```bash
opencode run --prompt "/slack-loop"
```

## 3. 필요한 Slack Bot Token Scopes

| Scope | 용도 |
|-------|------|
| `chat:write` | 메시지 전송 |
| `channels:history` | 채널 메시지 읽기 |
| `groups:history` | 비공개 채널 메시지 읽기 |
| `reactions:write` | 리액션 추가 |
| `reactions:read` | 리액션 읽기 |
| `channels:read` | 채널 목록 조회 |
| `files:write` | 파일 업로드 (긴 메시지) |
| `users:read` | 봇 ID 자동 감지 |

## 4. Slack App 생성 순서

1. https://api.slack.com/apps → "Create New App" → "From scratch"
2. Bot Token Scopes 추가 (위 테이블 참조)
3. "Install to Workspace" → Bot User OAuth Token 복사 (`xoxb-...`)
4. 봇을 채널에 초대: `/invite @봇이름`
5. 채널 ID 확인: 채널 이름 클릭 → 하단 "Channel ID" 복사
