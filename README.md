# CC-usage

**Claude Code 사용량을 실시간으로 모니터링하는 데스크톱 앱**

![CC-usage Screenshot](screenshots/cc-usage-dark.png)

## Overview

CC-usage는 Claude Code의 rate limit 데이터를 실시간으로 시각화하는 경량 데스크톱 앱입니다. Claude Code의 HUD(status line)가 이미 수집하는 데이터를 파일로 덤프하고, 앱이 이를 읽어 표시합니다. **추가 API 호출이나 토큰 소모 없이** 동작합니다.

## Features

- **5시간 세션 한도** — 사용률(%), 남은 시간, 리셋 시각 표시
- **7일 주간 한도** — 사용률(%), 남은 일/시간, 리셋 요일+시각 표시
- **실시간 갱신** — 5초마다 자동 업데이트, 1초 단위 카운트다운
- **다크/라이트 모드** — 주황 테마 기반 모드 전환
- **제로 토큰 소모** — HUD가 이미 받는 데이터를 파일로 저장할 뿐, 추가 API 호출 없음

## How It Works

```
Claude Code (HUD) → rate-limits.json → CC-usage App
```

1. Claude Code의 HUD 스크립트가 `data.rate_limits`를 `~/.claude/cache/rate-limits.json`에 기록
2. CC-usage 앱이 해당 파일을 5초마다 읽어 게이지바로 표시
3. Claude Code가 실행 중일 때 자동으로 데이터가 갱신됨

## Quick Start

### Prerequisites

- **Claude Code CLI** — [공식 사이트](https://claude.ai/code)에서 설치
- **macOS** — Apple Silicon / Intel 지원
- **Rust** 1.70+ (소스 빌드 시)
- **Node.js** 18+

### Installation

1. [Releases](../../releases) 페이지에서 `.dmg` 다운로드
2. DMG 열어서 Applications 폴더로 드래그
3. 앱 실행

### HUD 설정

CC-usage가 데이터를 받으려면 Claude Code HUD 스크립트에 rate-limits 덤프 코드를 추가해야 합니다.

현재 사용 중인 HUD 스크립트 (`~/.claude/settings.json`의 `statusLine.command`에서 확인)에 다음을 추가하세요:

```javascript
// 기존 import에 추가
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

// main() 함수 내, console.log(output) 직전에 추가
try {
  var homeDir = process.env.HOME || process.env.USERPROFILE || "";
  var cacheDir = join(homeDir, ".claude", "cache");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    join(cacheDir, "rate-limits.json"),
    JSON.stringify({
      rate_limits: data.rate_limits || {},
      model: data.model || {},
      context_window: data.context_window || {},
      updated_at: new Date().toISOString(),
    }, null, 2)
  );
} catch (_e) { /* ignore */ }
```

## Build from Source

```bash
# Clone
git clone https://github.com/HSUNEH/CC-usage.git
cd CC-usage

# Install dependencies
npm install

# Development
npm run tauri dev

# Production build
npm run tauri build
```

빌드 결과물: `src-tauri/target/release/bundle/macos/CC-usage.app`

## Tech Stack

- **Frontend**: React 18 + TypeScript + Vite + Tailwind CSS
- **Backend**: Rust (Tauri 2)
- **Data Source**: Claude Code HUD (`~/.claude/cache/rate-limits.json`)

## Acknowledgments

- Originally forked from [Claude Code Usage Dashboard](https://github.com/Zollicoff/Claude_Code_Usage_Dashboard)
- Built with [Tauri](https://tauri.app/)

## License

AGPL-3.0 — see [LICENSE](LICENSE) for details.
