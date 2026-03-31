# CC-usage

**Claude Code 사용량을 실시간으로 모니터링하는 데스크톱 앱**

![CC-usage Screenshot](screenshots/cc-usage-dark.png)

## Installation

### Step 1. 앱 설치

```bash
# 소스에서 빌드 (Rust 1.70+, Node.js 18+ 필요)
git clone https://github.com/HSUNEH/CC-usage.git
cd CC-usage
npm install
npm run tauri build

# 빌드된 앱 실행
open src-tauri/target/release/bundle/macos/CC-usage.app
```

> 또는 [Releases](../../releases) 페이지에서 `.dmg`를 다운로드하세요.

### Step 2. HUD 설정 (필수)

CC-usage는 Claude Code HUD가 생성하는 데이터 파일을 읽습니다.  
현재 사용 중인 HUD 스크립트에 아래 코드를 추가하세요.

> HUD 스크립트 경로: `~/.claude/settings.json` → `statusLine.command`에서 확인

```javascript
// 1. 기존 import에 추가
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

// 2. main() 함수 내, console.log() 직전에 추가
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

### Step 3. 실행

1. Claude Code를 아무 터미널에서 실행 (HUD가 데이터를 자동 생성)
2. CC-usage 앱 실행
3. 끝!

## Features

- **5시간 세션 한도** — 사용률(%), 남은 시간, 리셋 시각
- **7일 주간 한도** — 사용률(%), 남은 일/시간, 리셋 요일+시각
- **실시간 갱신** — 5초마다 자동 업데이트, 1초 카운트다운
- **다크/라이트 모드** — 주황 테마 기반 전환
- **제로 토큰 소모** — 추가 API 호출 없음

## How It Works

```
Claude Code (HUD) → ~/.claude/cache/rate-limits.json → CC-usage App
```

HUD가 이미 받고 있는 `data.rate_limits`를 파일로 덤프할 뿐, 추가 API 호출이 없어 **토큰 소모 0**입니다.

## Tech Stack

- **Frontend**: React 18 + TypeScript + Vite + Tailwind CSS
- **Backend**: Rust (Tauri 2)
- **Data**: Claude Code HUD → `rate-limits.json`

## Acknowledgments

- Originally forked from [Claude Code Usage Dashboard](https://github.com/Zollicoff/Claude_Code_Usage_Dashboard)
- Built with [Tauri](https://tauri.app/)

## License

AGPL-3.0 — see [LICENSE](LICENSE) for details.
