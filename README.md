# CC-usage v1.6.0

**Claude Code 사용량을 실시간으로 모니터링하는 macOS 데스크톱 앱**

**어디서 Claude를 쓰든 한 자리에서 확인**:
원격 서버에서 `claude` CLI를 돌리든, 다른 컴퓨터에서 작업하든, claude.ai 웹에서 쓰든 — 이 앱은 **Anthropic 서버 측 사용량을 직접 조회**하기 때문에 노트북을 열어두기만 해도 메뉴바에 최신 값이 뜹니다. 로컬 CLI가 돌고 있지 않아도 OK.

![CC-usage Screenshot](screenshots/cc-usage-dark.png)

### 메뉴바 표시

macOS 메뉴바에 5시간 세션의 남은 시간과 사용률이 항상 표시됩니다.

![menubar](screenshots/menubar.png)

## Installation

### Claude Code에서 설치 (권장)

Claude Code에 다음과 같이 입력:

```
https://github.com/HSUNEH/CC-usage 설치해줘
```

### 소스에서 빌드

```bash
# Rust 1.70+, Node.js 18+ 필요
git clone https://github.com/HSUNEH/CC-usage.git
cd CC-usage
npm install
npm run tauri build

open src-tauri/target/release/bundle/macos/CC-usage.app
```

### 첫 실행

1. 앱을 실행하면 **로그인 화면**이 뜹니다.
2. "로그인 시작" 클릭 → 브라우저에서 Anthropic OAuth 페이지 → 로그인 + 권한 승인
3. Anthropic이 code를 표시합니다. 전체를 **복사**해서 앱 입력창에 붙여넣고 "교환" 클릭
4. 완료. 메뉴바에 사용률이 표시됩니다.

**Note:** 이 앱은 Claude Code CLI와 완전 분리된 독립 토큰을 사용합니다. `claude` CLI를 따로 설치하지 않아도 동작하며, 설치돼 있더라도 CLI 토큰은 건드리지 않습니다.

## Features

- 🌐 **원격/다기기 사용량 반영** — SSH로 붙은 서버에서 `claude` 돌리든, 다른 맥에서 쓰든, claude.ai 웹에서 쓰든 **모두 이 앱 하나에 실시간 반영**. 로컬 CLI 파일 의존 0.
- ⚡ **적응형 폴링** — 창 볼 때 15초, 닫으면 60초 주기로 Anthropic API 호출 → 뒷주머니에 넣어둔 노트북도 최신값 유지
- 🔐 **앱 자체 OAuth 로그인/로그아웃** — Claude Code CLI와 **완전 분리된** 독립 Keychain 엔트리 사용. CLI 로그인 세션을 건드리지 않음
- 📊 **5시간 세션 + 7일 주간 한도** — 사용률(%), 남은 시간, 리셋 시각
- 🖥️ **메뉴바 표시** — 5시간 세션 남은 시간 + 사용률이 메뉴바에 항상 표시
- 🔔 **슬립 복귀 자동 갱신** — 맥이 깨어나면 즉시 API 재호출
- 🛡️ **원인별 진단 UI** — 토큰 없음 / 만료 / 네트워크 / API 에러를 구분해서 안내
- 🎨 **다크/라이트 모드** — 주황 테마 기반 전환

## How It Works

```
CC-usage App
  │
  ├─ 앱 자체 OAuth 로그인 (Keychain: CC-usage-credentials)
  │    PKCE + rotating refresh token 자체 관리
  │    → Claude Code CLI Keychain은 전혀 건드리지 않음
  │
  └─ Haiku Messages API (적응형 15s/60s 주기)
       POST /v1/messages → "." (9토큰)
       ← 응답 헤더에서 5h/7d utilization % 추출
       ← 이 숫자는 Anthropic 서버 측 누적값 →
         어디서 Claude를 쓰든 반영됨
```

**핵심:** 앱이 Anthropic Haiku API에 아주 작은 요청을 주기적으로 보내고, 응답 헤더(`anthropic-ratelimit-unified-*`)에서 사용률을 읽습니다. 이 값은 **계정 전체의 사용 누적량**이라, 사용자가 어느 기기/위치에서 Claude를 쓰고 있든 이 앱 하나로 추적됩니다.

## Tech Stack

- **Frontend**: React 18 + TypeScript + Vite + Tailwind CSS
- **Backend**: Rust (Tauri 2) + reqwest
- **Auth**: OAuth token (macOS Keychain)
- **Data**: Anthropic Messages API 응답 헤더 (`anthropic-ratelimit-unified-*`)

## Acknowledgments

- Originally forked from [Claude Code Usage Dashboard](https://github.com/Zollicoff/Claude_Code_Usage_Dashboard)
- Built with [Tauri](https://tauri.app/)

## License

AGPL-3.0 — see [LICENSE](LICENSE) for details.
