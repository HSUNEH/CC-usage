import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { AuthModal, type AuthStatus } from "./components/AuthModal";
import { LogoutButton } from "./components/LogoutButton";

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

interface UsageEnvelope {
  seq: number;
  data: UsageApiResponse;
  received_at: string;
}

type UsageError =
  | { type: "TokenMissing" }
  | { type: "TokenExpired" }
  | { type: "NetworkError"; data: string }
  | { type: "RateLimitHeaderMissing"; data: { status: number } }
  | { type: "UnexpectedStatus"; data: { status: number; body_snippet: string } }
  | { type: "RefreshRateLimited" };

type ErrorState =
  | { kind: "token_missing" }
  | { kind: "token_expired" }
  | { kind: "network"; detail: string }
  | { kind: "api"; detail: string };

type AuthState = "loading" | "logged_out" | "logged_in";

function mapError(err: any): ErrorState {
  const e = err as UsageError;
  if (typeof e === "string") {
    if (/token|auth/i.test(e)) return { kind: "token_missing" };
    if (/network|timeout|connect/i.test(e)) return { kind: "network", detail: e };
    return { kind: "api", detail: e };
  }
  switch (e.type) {
    case "TokenMissing": return { kind: "token_missing" };
    case "TokenExpired": return { kind: "token_expired" };
    case "NetworkError": return { kind: "network", detail: e.data };
    case "RateLimitHeaderMissing":
      return { kind: "api", detail: `rate limit header missing (HTTP ${e.data.status})` };
    case "UnexpectedStatus":
      return { kind: "api", detail: `HTTP ${e.data.status}: ${e.data.body_snippet}` };
    case "RefreshRateLimited":
      return { kind: "api", detail: "refresh rate limited" };
  }
}

const FILE_INTERVAL = 30000;

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


function ErrorBanner({ state, onCopy }: { state: ErrorState; onCopy: () => void }) {
  const isNetwork = state.kind === "network";
  return (
    <div
      className={`flex items-center justify-between px-3 py-2 text-xs rounded-md mb-3 ${
        isNetwork
          ? "bg-yellow-500/20 text-yellow-400"
          : "bg-red-500/20 text-red-400"
      }`}
    >
      <span>{isNetwork ? "네트워크 오류" : "API 응답 이상"}</span>
      <button onClick={onCopy} className="underline opacity-70 hover:opacity-100">
        복사
      </button>
    </div>
  );
}

function App() {
  const appDataRef = useRef<AppData | null>(null);
  const lastSeqRef = useRef(0);
  const [displayData, setDisplayData] = useState<AppData | null>(null);
  const [errorState, setErrorState] = useState<ErrorState | null>(null);
  const [now, setNow] = useState(Date.now());
  const [isDark, setIsDark] = useState(true);

  // Auth state
  const [authState, setAuthState] = useState<AuthState>("loading");
  const [firstRun, setFirstRun] = useState(false);
  const authStateRef = useRef<AuthState>("loading");
  useEffect(() => {
    authStateRef.current = authState;
  }, [authState]);

  // seq 리셋 on auth state change (C3)
  useEffect(() => {
    lastSeqRef.current = -1;
  }, [authState]);

  // 부트스트랩: auth_status 호출
  useEffect(() => {
    (async () => {
      try {
        const status = await invoke<AuthStatus>("auth_status");
        setFirstRun(status.first_run);
        setAuthState(status.logged_in ? "logged_in" : "logged_out");
      } catch {
        setAuthState("logged_out");
      }
    })();
  }, []);

  const toggleTheme = () => {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.classList.toggle("dark", next);
    document.documentElement.classList.toggle("light", !next);
  };

  const updateTray = (pct: number, resetsAt: string | null) => {
    invoke("update_tray", { pct, resetsAt }).catch(() => {});
  };

  const loadFile = useCallback(async () => {
    try {
      const result = await invoke<RateLimitData>("read_rate_limits");
      const fivePct = result.rate_limits?.five_hour?.used_percentage ?? 0;
      const sevenPct = result.rate_limits?.seven_day?.used_percentage ?? 0;
      if (fivePct === 0 && sevenPct === 0 && appDataRef.current) return;
      if (appDataRef.current?.source === "api") {
        const apiTime = new Date(appDataRef.current.data.updated_at).getTime();
        const fileTime = new Date(result.updated_at).getTime();
        if (fileTime <= apiTime) return;
      }
      const newData: AppData = { source: "file", data: result };
      appDataRef.current = newData;
      setDisplayData(newData);
      setErrorState(null);
      const fh = result.rate_limits?.five_hour;
      const resetRaw = fh?.resets_at ?? fh?.reset_at;
      const resetsAt = resetRaw
        ? new Date(resetRaw < 1e12 ? resetRaw * 1000 : resetRaw).toISOString()
        : null;
      updateTray(fh?.used_percentage ?? 0, resetsAt);
    } catch {
      // 파일 없으면 무시
    }
  }, []);

  const handleError = useCallback((payload: any) => {
    const mapped = mapError(payload);
    if (mapped.kind === "token_missing" || mapped.kind === "token_expired") {
      setAuthState("logged_out");
      return;
    }
    if (appDataRef.current) return;
    setErrorState(mapped);
  }, []);

  const lastForceRefreshAt = useRef(0);
  const refresh = useCallback(() => {
    const ts = Date.now();
    if (ts - lastForceRefreshAt.current < 1000) return;
    lastForceRefreshAt.current = ts;
    invoke("force_refresh").catch(() => {});
  }, []);

  // Event listeners (C2 — guard by authStateRef)
  useEffect(() => {
    loadFile();
    const fileTimer = setInterval(loadFile, FILE_INTERVAL);

    let unlistenU: UnlistenFn | undefined;
    let unlistenE: UnlistenFn | undefined;

    (async () => {
      unlistenU = await listen<UsageEnvelope>("usage-updated", (e) => {
        if (authStateRef.current !== "logged_in") return;
        if (e.payload.seq <= lastSeqRef.current) return;
        lastSeqRef.current = e.payload.seq;
        const newData: AppData = { source: "api", data: e.payload.data };
        appDataRef.current = newData;
        setDisplayData(newData);
        setErrorState(null);
      });
      unlistenE = await listen<UsageError>("usage-error", (e) => {
        if (authStateRef.current !== "logged_in") return;
        handleError(e.payload);
      });
      const cached = await invoke<UsageEnvelope | null>("get_last_usage");
      if (cached && authStateRef.current === "logged_in" && cached.seq > lastSeqRef.current) {
        lastSeqRef.current = cached.seq;
        const newData: AppData = { source: "api", data: cached.data };
        appDataRef.current = newData;
        setDisplayData(newData);
      }
      if (authStateRef.current === "logged_in") {
        invoke("force_refresh").catch(() => {});
      }
    })();

    return () => {
      clearInterval(fileTimer);
      unlistenU?.();
      unlistenE?.();
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // 화면 복귀(슬립 해제) 시 즉시 force_refresh
  useEffect(() => {
    const onWake = () => {
      if (!document.hidden && authStateRef.current === "logged_in") {
        invoke("force_refresh").catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", onWake);
    return () => document.removeEventListener("visibilitychange", onWake);
  }, []);

  const handleAuthSuccess = (status: AuthStatus) => {
    setFirstRun(status.first_run);
    lastSeqRef.current = -1;
    setAuthState("logged_in");
    invoke("force_refresh").catch(() => {});
  };

  const handleLogout = () => {
    lastSeqRef.current = -1;
    appDataRef.current = null;
    setDisplayData(null);
    setErrorState(null);
    setAuthState("logged_out");
  };

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

  // Auth 라우팅
  if (authState === "loading") {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="text-center space-y-2">
          <div className="w-6 h-6 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-xs text-muted-foreground">로딩 중...</p>
        </div>
      </div>
    );
  }

  if (authState === "logged_out") {
    return <AuthModal firstRun={firstRun} onSuccess={handleAuthSuccess} />;
  }

  // logged_in 경로
  const showFullDiag =
    errorState &&
    (errorState.kind === "token_missing" || errorState.kind === "token_expired");
  const showBanner = errorState && !showFullDiag;

  if (showFullDiag) {
    return <AuthModal firstRun={firstRun} onSuccess={handleAuthSuccess} />;
  }

  if (!displayData) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="text-center space-y-2">
          <div className="w-6 h-6 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-xs text-muted-foreground">로딩 중...</p>
        </div>
      </div>
    );
  }

  let sessionPct: number;
  let sessionReset: number | null;
  let sevenDayPct: number;
  let sevenDayReset: number | null;
  let updatedAt: string;
  let dataSource: string;

  if (displayData.source === "api") {
    const d = displayData.data;
    sessionPct = Math.min(100, Math.max(0, Math.round(d.five_hour?.utilization ?? 0)));
    sessionReset = getResetMs(d.five_hour?.resets_at);
    sevenDayPct = Math.min(100, Math.max(0, Math.round(d.seven_day?.utilization ?? 0)));
    sevenDayReset = getResetMs(d.seven_day?.resets_at);
    updatedAt = d.updated_at;
    dataSource = "API";
  } else {
    const d = displayData.data;
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
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-base font-bold">플랜 사용량 한도</h1>
        <LogoutButton onLogout={handleLogout} />
      </div>

      {showBanner && (
        <ErrorBanner
          state={errorState}
          onCopy={() => navigator.clipboard.writeText(JSON.stringify(errorState, null, 2))}
        />
      )}

      <div className="space-y-5">
        <section>
          <h2 className="text-sm font-semibold mb-0.5">현재 세션</h2>
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
            <span>{formatRemaining(sessionReset)}</span>
            <span>{formatResetTime(sessionReset)}</span>
          </div>
          <ProgressBar pct={sessionPct} />
        </section>

        <hr className="border-border" />

        <section>
          <h2 className="text-sm font-semibold mb-0.5">주간 한도</h2>
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
            <span>{formatRemaining(sevenDayReset)}</span>
            <span>{formatResetTime(sevenDayReset)}</span>
          </div>
          <ProgressBar pct={sevenDayPct} />
        </section>

        <hr className="border-border" />

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

        <div className="flex items-center justify-between pt-2">
          <button
            onClick={toggleTheme}
            className="flex items-center space-x-1.5 text-xs px-3 py-1.5 rounded-md bg-muted hover:opacity-80 transition-opacity"
          >
            <span>{isDark ? "☀️" : "🌙"}</span>
          </button>
          <button
            onClick={refresh}
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
