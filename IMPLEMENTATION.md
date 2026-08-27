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
- [ ] Workspace / File / PTY / Process API
- [ ] CodexDriver + ChatGPT/device auth
- [ ] ClaudeDriver + subscription/API auth
- [ ] OpenAI/Anthropic compatible drivers
- [ ] Task/session persistence
- [ ] Persistent Chromium daemon + Playwright/CDP Browser MCP
- [ ] Browser Live View
- [ ] KasmVNC + Computer MCP + Take Control
- [ ] Web Push 및 background lifecycle 연결
- [ ] 복구/restart/reconnect 로직

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
