import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface UsageWindow {
  utilization: number | null;
  resets_at: string | null;
}

interface ExtraUsage {
  is_enabled: boolean | null;
  monthly_limit: number | null;
  used_credits: number | null;
  utilization: number | null;
}

interface UsageApiResponse {
  five_hour: UsageWindow | null;
  seven_day: UsageWindow | null;
  seven_day_sonnet: UsageWindow | null;
  seven_day_opus: UsageWindow | null;
  extra_usage: ExtraUsage | null;
  source: string;
  updated_at: string;
}

interface RateLimitData {
  rate_limits: Record<string, any>;
  model: Record<string, any>;
  updated_at: string;
}

type AppData =
  | { source: "api"; data: UsageApiResponse }
  | { source: "file"; data: RateLimitData };

const REFRESH_INTERVAL = 30000;

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="flex items-center space-x-3">
      <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700 ease-out"
          style={{
            width: `${Math.max(1, pct)}%`,
            backgroundColor:
              pct < 50
                ? "#D97757"
                : pct < 80
                  ? "#E8944A"
                  : "#CC4422",
          }}
        />
      </div>
      <span className="text-xs text-muted-foreground w-20 text-right tabular-nums">
        {pct}% 사용됨
      </span>
    </div>
  );
}

type ErrorType = "no_token" | "auth_expired" | "network" | "unknown";

function getErrorType(apiError: string, _fileError: string): ErrorType {
  if (apiError.includes("auth_expired")) return "auth_expired";
  if (apiError.includes("token_error") || apiError.includes("토큰을 찾을 수 없습니다"))
    return "no_token";
  if (apiError.includes("API 요청 실패")) return "network";
  return "unknown";
}

function SetupScreen({
  errorType,
  onRetry,
}: {
  errorType: ErrorType;
  onRetry: () => void;
}) {
  if (errorType === "no_token") {
    return (
      <div className="h-screen flex items-center justify-center p-6">
        <div className="max-w-sm space-y-5">
          <div className="space-y-1">
            <h1 className="text-sm font-bold">초기 설정이 필요합니다</h1>
            <p className="text-xs text-muted-foreground">
              사용량 데이터를 가져오려면 Claude Code에 로그인되어 있어야 합니다.
            </p>
          </div>

          <div className="space-y-3">
            <div className="flex items-start space-x-3">
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold mt-0.5">
                1
              </span>
              <div>
                <p className="text-xs font-semibold">Claude Code CLI 설치</p>
                <code className="text-[11px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded block mt-1">
                  npm install -g @anthropic-ai/claude-code
                </code>
              </div>
            </div>

            <div className="flex items-start space-x-3">
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold mt-0.5">
                2
              </span>
              <div>
                <p className="text-xs font-semibold">터미널에서 로그인</p>
                <code className="text-[11px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded block mt-1">
                  claude
                </code>
                <p className="text-[11px] text-muted-foreground mt-1">
                  브라우저에서 OAuth 인증이 진행됩니다.
                  <br />
                  로그인 완료 후 토큰이 Keychain에 저장됩니다.
                </p>
              </div>
            </div>

            <div className="flex items-start space-x-3">
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold mt-0.5">
                3
              </span>
              <div>
                <p className="text-xs font-semibold">이 앱에서 새로고침</p>
                <p className="text-[11px] text-muted-foreground mt-1">
                  로그인 후 아래 버튼을 누르면 사용량이 표시됩니다.
                </p>
              </div>
            </div>
          </div>

          <button
            onClick={onRetry}
            className="w-full text-xs px-3 py-2 rounded-md bg-[#D97757] text-white hover:opacity-90 transition-opacity font-medium"
          >
            연결 확인
          </button>
        </div>
      </div>
    );
  }

  if (errorType === "auth_expired") {
    return (
      <div className="h-screen flex items-center justify-center p-6">
        <div className="max-w-sm space-y-5">
          <div className="space-y-1">
            <h1 className="text-sm font-bold">토큰이 만료되었습니다</h1>
            <p className="text-xs text-muted-foreground">
              OAuth 토큰이 만료되어 사용량 데이터를 가져올 수 없습니다.
            </p>
          </div>

          <div className="space-y-3">
            <div className="flex items-start space-x-3">
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold mt-0.5">
                1
              </span>
              <div>
                <p className="text-xs font-semibold">터미널에서 다시 로그인</p>
                <code className="text-[11px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded block mt-1">
                  claude
                </code>
                <p className="text-[11px] text-muted-foreground mt-1">
                  Claude Code를 실행하면 토큰이 자동으로 갱신됩니다.
                </p>
              </div>
            </div>

            <div className="flex items-start space-x-3">
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold mt-0.5">
                2
              </span>
              <div>
                <p className="text-xs font-semibold">이 앱에서 새로고침</p>
              </div>
            </div>
          </div>

          <button
            onClick={onRetry}
            className="w-full text-xs px-3 py-2 rounded-md bg-[#D97757] text-white hover:opacity-90 transition-opacity font-medium"
          >
            다시 시도
          </button>
        </div>
      </div>
    );
  }

  // network / unknown
  return (
    <div className="h-screen flex items-center justify-center p-6">
      <div className="max-w-sm space-y-4">
        <div className="space-y-1">
          <h1 className="text-sm font-bold">연결할 수 없습니다</h1>
          <p className="text-xs text-muted-foreground">
            {errorType === "network"
              ? "네트워크 연결을 확인해주세요. Anthropic API 서버에 접근할 수 없습니다."
              : "알 수 없는 오류가 발생했습니다. 잠시 후 다시 시도해주세요."}
          </p>
        </div>
        <button
          onClick={onRetry}
          className="w-full text-xs px-3 py-2 rounded-md bg-muted hover:bg-muted/80 transition-colors font-medium"
        >
          다시 시도
        </button>
      </div>
    </div>
  );
}

function App() {
  const [appData, setAppData] = useState<AppData | null>(null);
  const [error, setError] = useState<ErrorType | null>(null);
  const [now, setNow] = useState(Date.now());
  const [isDark, setIsDark] = useState(true);

  const toggleTheme = () => {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.classList.toggle("dark", next);
    document.documentElement.classList.toggle("light", !next);
  };

  const updateTray = (pct: number, resetsAt: string | null) => {
    invoke("update_tray", { pct, resetsAt }).catch(() => {});
  };

  const loadData = useCallback(async () => {
    let apiErrorMsg = "";

    // 1차: OAuth API 직접 호출
    try {
      const result = await invoke<UsageApiResponse>("fetch_usage_api");
      setAppData({ source: "api", data: result });
      setError(null);
      updateTray(result.five_hour?.utilization ?? 0, result.five_hour?.resets_at ?? null);
      return;
    } catch (apiErr) {
      apiErrorMsg = String(apiErr);
      if (apiErrorMsg.includes("auth_expired")) {
        setError("auth_expired");
        return;
      }
      console.warn("fetch_usage_api failed, falling back to file:", apiErrorMsg);
    }

    // 2차: 파일 기반 fallback
    try {
      const result = await invoke<RateLimitData>("read_rate_limits");
      setAppData({ source: "file", data: result });
      setError(null);
      const fh = result.rate_limits?.five_hour;
      const resetRaw = fh?.resets_at ?? fh?.reset_at;
      const resetsAt = resetRaw
        ? new Date(resetRaw < 1e12 ? resetRaw * 1000 : resetRaw).toISOString()
        : null;
      updateTray(fh?.used_percentage ?? 0, resetsAt);
    } catch (fileErr) {
      const fileErrorMsg = String(fileErr);
      setError(getErrorType(apiErrorMsg, fileErrorMsg));
    }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [loadData]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const getResetMs = (value: string | number | null | undefined): number | null => {
    if (value == null) return null;
    if (typeof value === "string") {
      const ms = new Date(value).getTime();
      return isNaN(ms) ? null : ms;
    }
    return value < 1e12 ? value * 1000 : value;
  };

  const formatRemaining = (resetMs: number | null) => {
    if (resetMs == null) return "";
    const remain = Math.max(0, resetMs - now);
    if (remain <= 0) return "재설정 완료";
    const d = Math.floor(remain / 86400000);
    const h = Math.floor((remain % 86400000) / 3600000);
    const m = Math.floor((remain % 3600000) / 60000);
    if (d > 0) return `${d}일 ${h}시간 ${m}분 후 재설정`;
    if (h > 0) return `${h}시간 ${m}분 후 재설정`;
    return `${m}분 후 재설정`;
  };

  const formatResetTime = (resetMs: number | null) => {
    if (resetMs == null) return "";
    const remain = Math.max(0, resetMs - now);
    if (remain <= 0) return "";
    const resetDate = new Date(resetMs);
    const days = ["일", "월", "화", "수", "목", "금", "토"];
    const dayName = days[resetDate.getDay()];
    const hours = resetDate.getHours();
    const mins = String(resetDate.getMinutes()).padStart(2, "0");
    const ampm = hours < 12 ? "오전" : "오후";
    const h12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
    if (remain < 86400000) return `${ampm} ${h12}:${mins}`;
    return `${dayName}요일 ${ampm} ${h12}:${mins}`;
  };

  const formatUpdated = (iso?: string) => {
    if (!iso) return "알 수 없음";
    const diff = Math.floor((now - new Date(iso).getTime()) / 1000);
    if (diff < 10) return "방금";
    if (diff < 60) return `${diff}초 전`;
    if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
    return `${Math.floor(diff / 3600)}시간 전`;
  };

  if (error) {
    return <SetupScreen errorType={error} onRetry={loadData} />;
  }

  if (!appData) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="text-center space-y-2">
          <div className="w-6 h-6 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-xs text-muted-foreground">로딩 중...</p>
        </div>
      </div>
    );
  }

  // 데이터 소스에 따라 값 추출
  let sessionPct: number;
  let sessionReset: number | null;
  let sevenDayPct: number;
  let sevenDayReset: number | null;
  let updatedAt: string;
  let dataSource: string;

  if (appData.source === "api") {
    const d = appData.data;
    sessionPct = Math.min(100, Math.max(0, Math.round(d.five_hour?.utilization ?? 0)));
    sessionReset = getResetMs(d.five_hour?.resets_at);
    sevenDayPct = Math.min(100, Math.max(0, Math.round(d.seven_day?.utilization ?? 0)));
    sevenDayReset = getResetMs(d.seven_day?.resets_at);
    updatedAt = d.updated_at;
    dataSource = "API";
  } else {
    const d = appData.data;
    const fiveHour = d.rate_limits?.five_hour;
    sessionPct = Math.round(fiveHour?.used_percentage ?? 0);
    sessionReset = getResetMs(fiveHour?.resets_at ?? fiveHour?.reset_at);
    const sevenDay = d.rate_limits?.seven_day;
    sevenDayPct = Math.round(sevenDay?.used_percentage ?? 0);
    sevenDayReset = getResetMs(sevenDay?.resets_at ?? sevenDay?.reset_at);
    updatedAt = d.updated_at;
    dataSource = "파일";
  }

  return (
    <div className="min-h-screen p-6 max-w-md mx-auto select-none">
      <h1 className="text-base font-bold mb-5">플랜 사용량 한도</h1>

      <div className="space-y-5">
        {/* Current Session (5h) */}
        <section>
          <h2 className="text-sm font-semibold mb-0.5">현재 세션</h2>
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
            <span>{formatRemaining(sessionReset)}</span>
            <span>{formatResetTime(sessionReset)}</span>
          </div>
          <ProgressBar pct={sessionPct} />
        </section>

        <hr className="border-border" />

        {/* 7-Day Limit */}
        <section>
          <h2 className="text-sm font-semibold mb-0.5">주간 한도</h2>
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
            <span>{formatRemaining(sevenDayReset)}</span>
            <span>{formatResetTime(sevenDayReset)}</span>
          </div>
          <ProgressBar pct={sevenDayPct} />
        </section>

        <hr className="border-border" />

        {/* Last updated + source */}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>마지막 업데이트: {formatUpdated(updatedAt)}</span>
          <span
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
              dataSource === "API"
                ? "bg-green-500/20 text-green-400"
                : "bg-yellow-500/20 text-yellow-400"
            }`}
          >
            {dataSource}
          </span>
        </div>

        {/* Bottom buttons */}
        <div className="flex items-center justify-between pt-2">
          <button
            onClick={toggleTheme}
            className="flex items-center space-x-1.5 text-xs px-3 py-1.5 rounded-md bg-muted hover:opacity-80 transition-opacity"
          >
            <span>{isDark ? "☀️" : "🌙"}</span>
            <span>{isDark ? "라이트 모드" : "다크 모드"}</span>
          </button>
          <button
            onClick={loadData}
            className="flex items-center space-x-1.5 text-xs px-3 py-1.5 rounded-md bg-muted hover:opacity-80 transition-opacity"
          >
            <span>↻</span>
            <span>새로고침</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export default App;
