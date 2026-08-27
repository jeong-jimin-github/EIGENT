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
- [x] CodexDriver + ChatGPT/device auth 골격 (실제 Codex CLI E2E 검증은 Issue로 추적)
- [x] ClaudeDriver + subscription/API auth 골격 (실제 stream-json E2E blocker는 Issue로 추적)
- [x] OpenAI/Anthropic compatible drivers
- [ ] Task/session persistence
- [ ] Persistent Chromium daemon + Playwright/CDP Browser MCP
- [ ] Browser Live View
- [ ] KasmVNC + Computer MCP + Take Control
- [ ] Web Push 및 background lifecycle 연결
- [ ] 복구/restart/reconnect 로직

## 현재 알려진 blocker

- Claude Code 2.1.238 OAuth 로그인/상태 감지는 정상이나 실제 `/api/agents/.../messages` 호출이 현재 exit code 1로 종료됨.
- CodexDriver는 Codex CLI 0.150.1 규격에 맞춰 구현했지만 현재 개발 머신에 Codex CLI가 전역 설치되어 있지 않아 실제 E2E 실행은 미검증.
- Task/session/process 상태는 아직 서버 메모리에만 유지되어 재시작 시 복구되지 않음.

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
