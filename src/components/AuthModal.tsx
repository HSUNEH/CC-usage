import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface AuthStatus {
  logged_in: boolean;
  first_run: boolean;
  expires_at_ms: number | null;
}

interface Props {
  firstRun: boolean;
  onSuccess: (status: AuthStatus) => void;
}

export function AuthModal({ firstRun, onSuccess }: Props) {
  const [phase, setPhase] = useState<"idle" | "awaiting-code" | "exchanging">("idle");
  const [code, setCode] = useState("");
  const [stateInput, setStateInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<{ authorize_url: string; state: string } | null>(null);

  const handleStart = async () => {
    setError(null);
    try {
      const result = await invoke<{ authorize_url: string; state: string }>("auth_start");
      setStarted(result);
      setStateInput(result.state);
      setPhase("awaiting-code");
    } catch (e: any) {
      const type = e?.type ?? e;
      if (type === "AlreadyPending") {
        setError("이미 진행 중인 로그인 세션이 있습니다. 기존 탭의 코드를 입력하거나 '취소' 후 재시도해주세요.");
        setPhase("awaiting-code");
      } else if (type === "ExchangeInProgress") {
        setError("교환 중입니다. 잠시 후 다시 시도해주세요.");
      } else {
        setError(JSON.stringify(e));
      }
    }
  };

  const handleUrlPaste = (url: string) => {
    try {
      const u = new URL(url.trim());
      const c = u.searchParams.get("code");
      const s = u.searchParams.get("state");
      if (c) setCode(c);
      if (s) setStateInput(s);
    } catch {
      // URL이 아닌 경우 무시
    }
  };

  const handleExchange = async () => {
    setPhase("exchanging");
    setError(null);
    try {
      // Anthropic returns code as "CODE#STATE" — split before sending
      let cleanCode = code.trim();
      let cleanState = stateInput.trim();
      if (cleanCode.includes("#")) {
        const [c, s] = cleanCode.split("#", 2);
        cleanCode = c;
        if (!cleanState && s) cleanState = s;
      }
      await invoke("auth_exchange", { code: cleanCode, state: cleanState });
      const latest = await invoke<AuthStatus>("auth_status");
      onSuccess(latest);
    } catch (e: any) {
      const type = e?.type ?? e;
      if (type === "PendingExpired") {
        setError("로그인 세션이 만료됐습니다 (10분 초과). 다시 시작해주세요.");
      } else if (type === "StateMismatch") {
        setError("state가 일치하지 않습니다. 정확히 복사했는지 확인해주세요.");
        setCode("");
        setStateInput("");
      } else if (type === "OAuth") {
        setError(`OAuth 교환 실패: ${JSON.stringify(e.data)}`);
      } else if (type === "ExchangeInProgress") {
        setError("이미 교환 중입니다. 잠시만 기다려 주세요.");
      } else {
        setError(JSON.stringify(e));
      }
      setPhase("awaiting-code");
    }
  };

  const handleCancel = () => {
    setPhase("idle");
    setStarted(null);
    setCode("");
    setStateInput("");
    setError(null);
  };

  return (
    <div className="h-screen flex items-center justify-center p-6 bg-background">
      <div className="max-w-md w-full space-y-4">
        <h1 className="text-xl font-bold">
          {firstRun ? "CC-usage에 로그인" : "로그인이 필요합니다"}
        </h1>

        {!firstRun && phase === "idle" && (
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded p-3 text-xs">
            이번 버전부터 앱 전용 로그인이 필요합니다. 이전 버전은 Claude Code CLI 토큰을
            공유했지만, 이제는 앱이 자체 OAuth 토큰을 관리합니다.
          </div>
        )}

        <p className="text-sm text-muted-foreground">
          Anthropic 계정 OAuth 인증이 필요합니다. "로그인 시작"을 누르면 브라우저가 열립니다.
        </p>

        {phase === "idle" && (
          <button
            onClick={handleStart}
            className="w-full px-4 py-2 rounded bg-[#D97757] text-white hover:opacity-90 transition-opacity font-medium"
          >
            로그인 시작
          </button>
        )}

        {phase !== "idle" && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              브라우저에서 로그인 후 리다이렉트된 URL 또는 code+state를 입력하세요.
            </p>
            <textarea
              placeholder="전체 URL 또는 code 값"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onBlur={(e) => {
                if (e.target.value.includes("://")) handleUrlPaste(e.target.value);
              }}
              className="w-full px-2 py-1 rounded border border-border bg-background text-xs font-mono resize-none"
              rows={2}
            />
            <input
              placeholder="state 값 (URL에서 자동 추출됨)"
              value={stateInput}
              onChange={(e) => setStateInput(e.target.value)}
              className="w-full px-2 py-1 rounded border border-border bg-background text-xs font-mono"
            />
            <div className="flex gap-2">
              <button
                onClick={handleExchange}
                disabled={phase === "exchanging" || !code.trim() || !stateInput.trim()}
                className="flex-1 px-4 py-2 rounded bg-[#D97757] text-white disabled:opacity-50 hover:opacity-90 transition-opacity font-medium"
              >
                {phase === "exchanging" ? "교환 중..." : "교환"}
              </button>
              <button
                onClick={handleCancel}
                className="px-4 py-2 rounded bg-muted hover:opacity-80 transition-opacity text-sm"
              >
                취소
              </button>
            </div>
          </div>
        )}

        {started && phase === "awaiting-code" && (
          <p className="text-xs text-muted-foreground break-all">
            authorize URL: <span className="opacity-60">{started.authorize_url.slice(0, 60)}...</span>
          </p>
        )}

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded p-3 text-xs flex justify-between items-start gap-2">
            <span className="flex-1 whitespace-pre-wrap">{error}</span>
            <button
              onClick={() => navigator.clipboard.writeText(error)}
              className="text-xs underline opacity-70 hover:opacity-100 shrink-0"
            >
              복사
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
