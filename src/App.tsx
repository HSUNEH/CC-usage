import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface RateLimitData {
  rate_limits: Record<string, any>;
  model: Record<string, any>;
  updated_at: string;
}

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

function App() {
  const [data, setData] = useState<RateLimitData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [isDark, setIsDark] = useState(true);

  const toggleTheme = () => {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.classList.toggle("dark", next);
    document.documentElement.classList.toggle("light", !next);
  };

  const loadData = useCallback(async () => {
    try {
      const result = await invoke<RateLimitData>("read_rate_limits");
      setData(result);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 5000);
    return () => clearInterval(interval);
  }, [loadData]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const getResetMs = (obj: any): number | null => {
    const v = obj?.resets_at ?? obj?.reset_at ?? obj?.reset;
    if (v == null) return null;
    return v < 1e12 ? v * 1000 : v;
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
    // Within 24 hours: just show time
    if (remain < 86400000) return `${ampm} ${h12}:${mins}`;
    // Beyond: show day + time
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
    return (
      <div className="h-screen flex items-center justify-center p-6">
        <div className="text-center space-y-3 max-w-xs">
          <p className="text-sm font-semibold">데이터를 불러올 수 없습니다</p>
          <p className="text-xs text-muted-foreground">
            Claude Code가 실행 중인지 확인해주세요.
            <br />
            HUD가 rate-limits.json을 생성해야 합니다.
          </p>
          <button
            onClick={loadData}
            className="text-xs px-3 py-1.5 rounded bg-muted hover:bg-muted/80 transition-colors"
          >
            다시 시도
          </button>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="text-center space-y-2">
          <div className="w-6 h-6 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-xs text-muted-foreground">로딩 중...</p>
        </div>
      </div>
    );
  }

  const fiveHour = data.rate_limits?.five_hour;
  const sessionPct = Math.round(fiveHour?.used_percentage ?? 0);
  const sessionReset = getResetMs(fiveHour);

  // Seven day limit
  const sevenDay = data.rate_limits?.seven_day;
  const sevenDayPct = Math.round(sevenDay?.used_percentage ?? 0);
  const sevenDayReset = getResetMs(sevenDay);

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
        {sevenDay && (
          <>
            <section>
              <h2 className="text-sm font-semibold mb-0.5">주간 한도</h2>
              <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
                <span>{formatRemaining(sevenDayReset)}</span>
                <span>{formatResetTime(sevenDayReset)}</span>
              </div>
              <ProgressBar pct={sevenDayPct} />
            </section>
            <hr className="border-border" />
          </>
        )}

        {/* Last updated */}
        <div className="text-xs text-muted-foreground">
          마지막 업데이트: {formatUpdated(data.updated_at)}
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
