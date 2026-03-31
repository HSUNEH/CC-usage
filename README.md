# CC-usage

**Claude Code 사용량을 실시간으로 모니터링하는 macOS 데스크톱 앱**

터미널 CLI, 웹(claude.ai) 어디서 사용하든 정확한 사용량을 표시합니다.

![CC-usage Screenshot](screenshots/cc-usage-dark.png)

### 메뉴바 표시

macOS 메뉴바에 5시간 세션의 남은 시간과 사용률이 항상 표시됩니다.

```
4h39m 5%
```

## Installation

### 방법 1: 다운로드 (권장)

1. [Releases](../../releases) 페이지에서 `CC-usage.zip` 다운로드
2. 압축 풀고 `CC-usage.app`을 Applications로 이동
3. 처음 열 때 "손상되었습니다" 경고가 뜨면:
   ```bash
   xattr -cr /Applications/CC-usage.app
   ```

### 방법 2: 소스에서 빌드

```bash
# Rust 1.70+, Node.js 18+ 필요
git clone https://github.com/HSUNEH/CC-usage.git
cd CC-usage
npm install
npm run tauri build

open src-tauri/target/release/bundle/macos/CC-usage.app
```

### Claude Code 로그인 (최초 1회)

앱이 Anthropic OAuth API를 통해 사용량을 가져오므로, Claude Code에 로그인되어 있어야 합니다.

```bash
npm install -g @anthropic-ai/claude-code
claude
```

브라우저에서 OAuth 인증 완료 후, 앱을 새로고침하면 사용량이 표시됩니다.

## Features

- **OAuth API 직접 호출** — CLI를 실행하지 않아도 정확한 사용량 표시
- **웹 사용분 반영** — claude.ai에서 사용한 양도 실시간 반영
- **메뉴바 표시** — 5시간 세션 남은 시간 + 사용률이 메뉴바에 항상 표시
- **5시간 세션 한도** — 사용률(%), 남은 시간, 리셋 시각
- **7일 주간 한도** — 사용률(%), 남은 일/시간, 리셋 요일+시각
- **자동 갱신** — 30초마다 자동 업데이트
- **자동 fallback** — API 실패 시 기존 파일 기반 방식으로 자동 전환
- **셋업 가이드** — 첫 사용자를 위한 단계별 안내 화면
- **다크/라이트 모드** — 주황 테마 기반 전환

## How It Works

```
CC-usage App → Anthropic OAuth API (30초마다)
                 ↓
            5h/7d 사용량 표시
                 ↓ (API 실패 시)
            ~/.claude/cache/rate-limits.json fallback
```

OAuth 토큰은 macOS Keychain에서 읽습니다 (Claude Code 로그인 시 자동 저장됨).

## Tech Stack

- **Frontend**: React 18 + TypeScript + Vite + Tailwind CSS
- **Backend**: Rust (Tauri 2) + reqwest
- **Auth**: OAuth token (macOS Keychain)
- **Data**: Anthropic Usage API (`/api/oauth/usage`)

## Acknowledgments

- Originally forked from [Claude Code Usage Dashboard](https://github.com/Zollicoff/Claude_Code_Usage_Dashboard)
- Built with [Tauri](https://tauri.app/)

## License

AGPL-3.0 — see [LICENSE](LICENSE) for details.
