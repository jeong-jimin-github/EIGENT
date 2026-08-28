# EIGENT Implementation Status

기획서의 Phase 순서에 맞춰 구현을 시작한 상태를 기록한다.

## 완료한 기반 작업

- [x] Palot 소스를 EIGENT 저장소 베이스로 가져오기
- [x] Browser-only Vite 개발 서버를 외부 접속 가능하도록 변경
- [x] 개발 시 `/api`, `/health` same-origin proxy 구성
- [x] Production Web 빌드(`apps/desktop/dist-web`) 추가
- [x] Bun/Hono 서버가 Production SPA 정적 파일을 직접 제공
- [x] 서버 기본 bind를 `0.0.0.0`으로 변경
- [x] PWA manifest + service worker + 모바일 standalone 메타데이터 추가
- [x] Provider-independent `AgentDriver` / `AgentEvent` 계약 패키지 추가
- [x] root `dev:cloud`, `build:web`, `start` 명령 추가

## 다음 구현 순서

- [x] Browser mode의 Electron-only Git API를 Hono backend로 이전
- [x] Workspace / File / PTY / Process API
- [x] CodexDriver + ChatGPT/device auth + 실제 Codex CLI E2E/interrupt/resume 검증
- [x] ClaudeDriver + subscription/API auth 골격 (실제 stream-json E2E blocker는 Issue로 추적)
- [x] OpenAI/Anthropic compatible drivers
- [x] Task/session/process persistence (SQLite + migration + event history)
- [ ] Persistent Chromium daemon + Playwright/CDP Browser MCP
- [ ] Browser Live View
- [ ] KasmVNC + Computer MCP + Take Control
- [ ] Web Push 및 background lifecycle 연결
- [x] 복구/restart/reconnect 로직 (durable run + SSE cursor replay + browser backoff)

## 현재 알려진 blocker

- Claude Code 2.1.238의 기존 `oauth_token` 상태는 호스트의 `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL`/`CLAUDE_CODE_USE_OPENAI` 주입으로 생긴 false-positive였음. Claude subscription 드라이버는 이제 해당 API/provider override를 제거하고 실행하며, 현재 개발 머신의 순수 first-party 상태는 미로그인(`loggedIn=false`)이라 실제 completion E2E는 `claude auth login --claudeai` 완료 전까지 차단됨.
- Codex CLI 0.150.1은 Windows에서 `/api/agents` 실제 E2E(stream/resume/YOLO/interrupt)를 검증했고, Ubuntu 26.04 네이티브 환경에서도 설치/ChatGPT 인증/device-auth challenge를 검증함. Linux 추가 turn은 현재 계정 사용량 한도 때문에 `thread.started` 이후 provider가 거절했으며 설치·인증 경로 자체는 정상.
- SQLite 기반 task/session/process 영속화와 stale 상태 복구, durable agent run, SSE cursor replay, Project Tools 재연결/backoff까지 구현됨.

## 현재 실행 방법

```bash
bun install
bun run dev:cloud
```

Production:

```bash
bun run build:web
bun run start
```
