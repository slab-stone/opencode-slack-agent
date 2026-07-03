---
description: "OpenCode Slack Agent - Slack DM 명령 수신/응답 루프, 메시지 전송, 리액션"
---

# /slack-loop — Slack 명령 대기 루프

이 스킬은 OpenCode 에이전트를 Slack 명령 수신 루프에 진입시킵니다.
루프에 진입하면 Slack 채널에서 사용자 메시지를 수신하고, OpenCode의 모든 능력을 활용하여 처리한 뒤 결과를 Slack으로 회신합니다.

## 커맨드 인자

`/slack-loop [채널]` 형태로 타겟 채널을 지정할 수 있습니다.

- 채널 ID: `D0BC8PB3D6Y`, `C01234ABCDE`
- 채널 이름: `#general`, `random`
- Slack URL: `https://myworkspace.slack.com/archives/C01234ABCDE`
- 사용자 ID (DM 열기): `U01234ABCDE`
- **미지정 시: 모든 채널에서 @멘션 + DM에 응답하는 모드**

인자가 주어지면 루프 시작 전에 `slack_resolve_channel`로 채널 ID를 확인하세요.
인자가 없으면 채널을 지정하지 않고 `slack_command_loop`를 호출하면 됩니다 (전체 inbox 감시).

## MCP 서버

이 스킬은 `slack-agent` MCP 서버를 제공합니다. 모든 도구 호출은 반드시 `skill_mcp(mcp_name="slack-agent", ...)` 형태로 호출하세요.

## 동작 방식

1. `slack_command_loop`를 호출하여 Slack 채널에서 실시간 메시지 수신 대기
2. 사용자 메시지가 수신되면 내용을 분석하고 적절한 작업 수행
3. **중간 과정은 수신된 메시지의 쓰레드(thread)로 발송** — 사용자 메시지의 `ts` 값을 `thread_ts`로 사용
4. **최종 결과는 채널에 직접 메시지로 응답** — `slack_respond`로 회신
5. 다시 `slack_command_loop`를 호출하여 다음 명령 대기
6. 이 사이클을 무한 반복

## 실행 지침

아래 루프를 따르세요:

```
0. (인자가 있으면) 채널 resolve:
   skill_mcp(mcp_name="slack-agent", tool_name="slack_resolve_channel", arguments={"input": "<커맨드 인자>"})
   → 반환된 channel_id를 이후 모든 호출에 사용
   (인자가 없으면 0단계 생략 — channel 파라미터 없이 호출하면 전체 멘션/DM 감시 모드)
1. skill_mcp(mcp_name="slack-agent", tool_name="slack_command_loop", arguments={"channel": "<resolved channel_id 또는 생략>", "timeout_seconds": 30, "greeting": "✅ OpenCode 에이전트 대기 중. 명령을 입력하세요."})
   - channel 생략 시: 모든 채널의 @멘션 + DM을 감시
   - 응답의 channel 필드를 확인하여 어떤 채널에서 온 메시지인지 파악
2. 명령이 수신되면 (reply_to.channel과 메시지의 ts 값을 기억):
   a. 즉시 쓰레드에 착수 메시지 발송:
      skill_mcp(mcp_name="slack-agent", tool_name="slack_reply_thread", arguments={"channel": "<메시지가 온 channel>", "thread_ts": "<사용자 메시지 ts>", "message": "🔍 분석 중..."})
   b. 요청된 작업 수행 (파일 편집, 코드 작성, 검색, 분석 등 — 모든 도구 사용 가능)
   c. 작업 중간중간 진행 상황을 같은 쓰레드에 보고:
      skill_mcp(mcp_name="slack-agent", tool_name="slack_reply_thread", arguments={"channel": "<메시지가 온 channel>", "thread_ts": "<사용자 메시지 ts>", "message": "✏️ 3개 파일 수정 중..."})
   d. 최종 결과는 채널에 직접 메시지로 회신:
      skill_mcp(mcp_name="slack-agent", tool_name="slack_respond", arguments={"channel": "<메시지가 온 channel>", "message": "✅ 완료! ..."})
3. 타임아웃이면 1번으로 돌아가 재개
4. "종료", "exit", "quit" 명령이면 루프 종료
```

## 쓰레드 응답 규칙 (필수)

- **중간 과정은 쓰레드로, 최종 결과는 채널 메시지로** 발송한다.
- `command_loop` 반환값의 메시지 `ts` 값을 중간 보고의 `thread_ts`로 사용한다.
- 중간 과정 보고에는 `slack_reply_thread`를, 최종 결과에는 `slack_respond` (thread_ts 없이)를 사용한다.
- 긴 작업(3개 이상 도구 호출)에서는 반드시 1회 이상 중간 진행 메시지를 쓰레드에 남긴다.
- 쓰레드에 중간 과정이 쌓이므로 사용자는 필요할 때만 쓰레드를 열어 상세를 확인할 수 있다.

## 중요 규칙

- 모든 Slack 도구는 `skill_mcp(mcp_name="slack-agent", tool_name="...", arguments={...})` 형태로 호출
- **중간 과정은 쓰레드로, 최종 결과는 채널 메시지로** 발송한다
- 작업 중에도 5~10개 도구 호출마다 `skill_mcp(mcp_name="slack-agent", tool_name="slack_command_loop", arguments={"timeout_seconds": 0})`으로 새 명령을 체크하세요
- 긴 작업 중에는 진행 상황을 같은 쓰레드에 중간 보고하세요
- 에러가 발생하면 사용자에게 해당 쓰레드로 알려주세요
- 사용자가 리액션(✅, ❌, 🚀 등)으로 응답할 수 있습니다

## 제공 도구 (mcp_name="slack-agent")

| tool_name | 용도 |
|-----------|------|
| `slack_resolve_channel` | 채널 ID/이름/URL → 채널 ID resolve |
| `slack_command_loop` | 명령 대기 (blocking/non-blocking) |
| `slack_check_inbox` | 인박스 확인 |
| `slack_send_message` | 메시지 전송 |
| `slack_respond` | 사용자 명령에 응답 |
| `slack_reply_thread` | 스레드 답장 |
| `slack_read_messages` | 채널 메시지 읽기 |
| `slack_get_thread` | 스레드 전체 읽기 |
| `slack_add_reaction` | 리액션 추가 |
| `slack_list_channels` | 채널 목록 조회 |

## 도구 호출 예시

```
# 채널 resolve (인자로 받은 값)
skill_mcp(mcp_name="slack-agent", tool_name="slack_resolve_channel", arguments={"input": "#general"})
# → {"ok": true, "channel_id": "C01234ABCDE", "source": "name_lookup"}

# 명령 대기
skill_mcp(mcp_name="slack-agent", tool_name="slack_command_loop", arguments={"channel": "C01234ABCDE", "timeout_seconds": 30})

# 중간 과정 보고 (쓰레드)
skill_mcp(mcp_name="slack-agent", tool_name="slack_reply_thread", arguments={"channel": "C01234ABCDE", "thread_ts": "1234567890.123456", "message": "🔍 코드 분석 중..."})

# 최종 결과 회신 (채널 메시지)
skill_mcp(mcp_name="slack-agent", tool_name="slack_respond", arguments={"channel": "C01234ABCDE", "message": "✅ 완료! 결과입니다."})
```
