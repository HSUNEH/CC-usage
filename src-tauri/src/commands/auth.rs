use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Instant, SystemTime};
use tauri::command;
use zeroize::ZeroizeOnDrop;

use super::auth_store::{
    self, CachedSecrets, LoadResult, delete_from_keychain, read_from_keychain,
    sentinel_create, sentinel_exists, write_to_keychain,
};
use base64::Engine as _;
use super::oauth::{self, OAuthError};

// ---------------------------------------------------------------------------
// RefreshGuard — 분당 5회 상한 + sleep/wake drift 감지
// ---------------------------------------------------------------------------

const MAX_REFRESH_PER_MIN: u32 = 5;

pub struct RefreshGuard {
    pub count: u32,
    pub window_start_mono: Instant,
    pub window_start_wall: SystemTime,
}

impl RefreshGuard {
    pub fn new() -> Self {
        Self {
            count: 0,
            window_start_mono: Instant::now(),
            window_start_wall: SystemTime::now(),
        }
    }

    /// sleep/wake 시 monotonic clock drift 감지: wall time gap이 2분 이상이면 창 리셋
    pub fn reset_if_drift(&mut self, now_wall: SystemTime) {
        let wall_elapsed = now_wall
            .duration_since(self.window_start_wall)
            .unwrap_or_default();
        let mono_elapsed = self.window_start_mono.elapsed();

        if wall_elapsed.as_secs() > mono_elapsed.as_secs() + 120 {
            self.count = 0;
            self.window_start_mono = Instant::now();
            self.window_start_wall = now_wall;
        }
    }

    /// 분당 5회 상한 체크. Ok(()) = 허용, Err = 제한 초과
    pub fn try_acquire(&mut self) -> Result<(), ()> {
        self.reset_if_drift(SystemTime::now());

        if self.window_start_mono.elapsed().as_secs() >= 60 {
            self.count = 0;
            self.window_start_mono = Instant::now();
            self.window_start_wall = SystemTime::now();
        }

        if self.count >= MAX_REFRESH_PER_MIN {
            return Err(());
        }

        self.count += 1;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// PendingAuth — PKCE 세션 (TTL 10분)
// ---------------------------------------------------------------------------

#[derive(ZeroizeOnDrop)]
pub struct PendingAuth {
    pub state: String,
    pub code_verifier: String,
    #[zeroize(skip)]
    pub created_at: Instant,
}

// ---------------------------------------------------------------------------
// ExchangeGuard — RAII, Drop 시 AtomicBool 해제
// ---------------------------------------------------------------------------

pub struct ExchangeGuard<'a>(&'a AtomicBool);

impl<'a> Drop for ExchangeGuard<'a> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

// ---------------------------------------------------------------------------
// AuthError
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Serialize)]
pub enum AuthError {
    Keychain(String),
    OAuth(String),
    AlreadyPending,
    ExchangeInProgress,
    PendingExpired,
    StateMismatch,
    RefreshRateLimited,
    NotLoggedIn,
}

impl fmt::Display for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AuthError::Keychain(e) => write!(f, "keychain error: {}", e),
            AuthError::OAuth(e) => write!(f, "oauth error: {}", e),
            AuthError::AlreadyPending => write!(f, "login already pending"),
            AuthError::ExchangeInProgress => write!(f, "exchange already in progress"),
            AuthError::PendingExpired => write!(f, "pending auth expired"),
            AuthError::StateMismatch => write!(f, "state mismatch"),
            AuthError::RefreshRateLimited => write!(f, "refresh rate limited"),
            AuthError::NotLoggedIn => write!(f, "not logged in"),
        }
    }
}

impl From<OAuthError> for AuthError {
    fn from(e: OAuthError) -> Self {
        AuthError::OAuth(e.to_string())
    }
}

// ---------------------------------------------------------------------------
// AuthStore
// ---------------------------------------------------------------------------

pub struct AuthStore {
    secrets: tokio::sync::Mutex<Option<CachedSecrets>>,
    refresh_lock: tokio::sync::Mutex<()>,
    pending: tokio::sync::Mutex<Option<PendingAuth>>,
    exchanging: AtomicBool,
    refresh_guard: parking_lot::Mutex<RefreshGuard>,
}

impl Default for AuthStore {
    fn default() -> Self {
        Self::new()
    }
}

impl AuthStore {
    pub fn new() -> Self {
        Self {
            secrets: tokio::sync::Mutex::new(None),
            refresh_lock: tokio::sync::Mutex::new(()),
            pending: tokio::sync::Mutex::new(None),
            exchanging: AtomicBool::new(false),
            refresh_guard: parking_lot::Mutex::new(RefreshGuard::new()),
        }
    }

    pub async fn load_from_keychain(&self) {
        let result = tokio::task::spawn_blocking(read_from_keychain)
            .await
            .unwrap_or(LoadResult::None);

        match result {
            LoadResult::Ok(s) => {
                *self.secrets.lock().await = Some(s);
            }
            LoadResult::None => {}
        }
    }

    pub async fn status(&self) -> AuthStatus {
        let secrets = self.secrets.lock().await;
        let logged_in = secrets.is_some();
        let expires_at_ms = secrets.as_ref().map(|s| s.expires_at_ms);
        let first_run = !logged_in && !sentinel_exists();
        AuthStatus {
            logged_in,
            first_run,
            expires_at_ms,
        }
    }

    pub async fn start_auth(&self) -> Result<AuthStartResult, AuthError> {
        // Exchange 중이면 거부 — exchange_code가 pending.take()를 하므로 충돌 방지
        if self.exchanging.load(std::sync::atomic::Ordering::Acquire) {
            return Err(AuthError::ExchangeInProgress);
        }

        // 기존 pending은 덮어쓰기 허용 — 사용자가 "로그인 시작"을 다시 누르면 fresh 세션
        let mut pending = self.pending.lock().await;

        let (verifier, challenge) = oauth::generate_pkce_pair();

        // Anthropic convention: state == verifier
        let state = verifier.clone();

        let scope = "org:create_api_key user:profile user:inference";
        let authorize_url = oauth::build_authorize_url(&challenge, &state, scope);

        *pending = Some(PendingAuth {
            state: state.clone(),
            code_verifier: verifier,
            created_at: Instant::now(),
        });

        Ok(AuthStartResult { authorize_url, state })
    }

    pub fn try_begin_exchange(&self) -> Result<ExchangeGuard<'_>, AuthError> {
        self.exchanging
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map(|_| ExchangeGuard(&self.exchanging))
            .map_err(|_| AuthError::ExchangeInProgress)
    }

    pub async fn exchange(&self, code: &str, state: &str) -> Result<(), AuthError> {
        let _guard = self.try_begin_exchange()?;

        let (verifier, pending_state) = {
            let mut pending = self.pending.lock().await;
            match pending.take() {
                None => return Err(AuthError::PendingExpired),
                Some(p) => {
                    // TTL 10분 체크
                    if p.created_at.elapsed().as_secs() > 600 {
                        return Err(AuthError::PendingExpired);
                    }
                    (p.code_verifier.clone(), p.state.clone())
                }
            }
        };

        if pending_state != state {
            return Err(AuthError::StateMismatch);
        }

        let token = oauth::exchange_code(code, &verifier, state)
            .await
            .map_err(AuthError::from)?;

        let now_ms = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        let expires_at_ms = now_ms
            + token.expires_in.unwrap_or(3600) as i64 * 1000;

        let new_secrets = CachedSecrets {
            access_token: token.access_token.clone(),
            refresh_token: token.refresh_token.clone().unwrap_or_default(),
            expires_at_ms,
        };

        // Keychain 먼저 저장 후 메모리 교체
        tokio::task::spawn_blocking({
            let access = token.access_token.clone();
            let refresh = token.refresh_token.clone().unwrap_or_default();
            move || {
                let s = CachedSecrets {
                    access_token: access,
                    refresh_token: refresh,
                    expires_at_ms,
                };
                write_to_keychain(&s)
            }
        })
        .await
        .map_err(|e| AuthError::Keychain(e.to_string()))?
        .map_err(|e| AuthError::Keychain(e.to_string()))?;

        *self.secrets.lock().await = Some(new_secrets);

        // sentinel 생성
        let _ = sentinel_create();

        Ok(())
    }

    pub async fn get_valid_access_token(&self) -> Result<String, AuthError> {
        {
            let secrets = self.secrets.lock().await;
            if let Some(ref s) = *secrets {
                let now_ms = SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as i64;
                if s.expires_at_ms - now_ms > 60_000 {
                    return Ok(s.access_token.clone());
                }
            } else {
                return Err(AuthError::NotLoggedIn);
            }
        }

        // Refresh 경로 — refresh_lock으로 직렬화
        let _refresh_lock = self.refresh_lock.lock().await;

        // double-check
        {
            let secrets = self.secrets.lock().await;
            if let Some(ref s) = *secrets {
                let now_ms = SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as i64;
                if s.expires_at_ms - now_ms > 60_000 {
                    return Ok(s.access_token.clone());
                }
            }
        }

        // rate limit 체크
        {
            let mut guard = self.refresh_guard.lock();
            guard.try_acquire().map_err(|_| AuthError::RefreshRateLimited)?;
        }

        let refresh_token = {
            let secrets = self.secrets.lock().await;
            secrets
                .as_ref()
                .map(|s| s.refresh_token.clone())
                .ok_or(AuthError::NotLoggedIn)?
        };

        let new_token = oauth::refresh_access_token(&refresh_token)
            .await
            .map_err(AuthError::from)?;

        let now_ms = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        let expires_at_ms = now_ms + new_token.expires_in.unwrap_or(3600) as i64 * 1000;

        let new_secrets = CachedSecrets {
            access_token: new_token.access_token.clone(),
            refresh_token: new_token.refresh_token.clone().unwrap_or(refresh_token),
            expires_at_ms,
        };

        tokio::task::spawn_blocking({
            let access = new_token.access_token.clone();
            let rt = new_token.refresh_token.clone().unwrap_or_default();
            move || {
                let s = CachedSecrets {
                    access_token: access,
                    refresh_token: rt,
                    expires_at_ms,
                };
                write_to_keychain(&s)
            }
        })
        .await
        .map_err(|e| AuthError::Keychain(e.to_string()))?
        .map_err(|e| AuthError::Keychain(e.to_string()))?;

        let access = new_secrets.access_token.clone();
        *self.secrets.lock().await = Some(new_secrets);

        Ok(access)
    }

    pub async fn force_refresh_now(&self) -> Result<String, AuthError> {
        self.get_valid_access_token().await
    }

    pub async fn logout(&self) -> Result<(), AuthError> {
        tokio::task::spawn_blocking(delete_from_keychain)
            .await
            .map_err(|e| AuthError::Keychain(e.to_string()))?
            .map_err(|e| AuthError::Keychain(e.to_string()))?;

        *self.secrets.lock().await = None;
        *self.pending.lock().await = None;
        self.exchanging.store(false, Ordering::Release);

        let _ = sentinel_create();

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Tauri command types
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Serialize)]
pub struct AuthStatus {
    pub logged_in: bool,
    pub first_run: bool,
    pub expires_at_ms: Option<i64>,
}

#[derive(Debug, serde::Serialize)]
pub struct AuthStartResult {
    pub authorize_url: String,
    pub state: String,
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[command]
pub async fn auth_status(store: tauri::State<'_, AuthStore>) -> Result<AuthStatus, AuthError> {
    Ok(store.status().await)
}

#[command]
pub async fn auth_start(
    app: tauri::AppHandle,
    store: tauri::State<'_, AuthStore>,
) -> Result<AuthStartResult, AuthError> {
    let result = store.start_auth().await?;
    use tauri_plugin_opener::OpenerExt;
    let _ = app.opener().open_url(&result.authorize_url, None::<&str>);
    Ok(result)
}

#[command]
pub async fn auth_exchange(
    store: tauri::State<'_, AuthStore>,
    code: String,
    state: String,
) -> Result<(), AuthError> {
    store.exchange(&code, &state).await
}

#[command]
pub async fn auth_logout(store: tauri::State<'_, AuthStore>) -> Result<(), AuthError> {
    store.logout().await
}

// ---------------------------------------------------------------------------
// Shim — T2에서 제거 예정
// ---------------------------------------------------------------------------

/// @deprecated T2에서 AuthStore::get_valid_access_token으로 교체 예정
#[allow(dead_code)]
pub fn get_oauth_token() -> Result<String, String> {
    match read_from_keychain() {
        LoadResult::Ok(s) => Ok(s.access_token.clone()),
        LoadResult::None => Err("not logged in".to_string()),
    }
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_guard_allows_up_to_5_per_minute() {
        let mut guard = RefreshGuard::new();
        for _ in 0..5 {
            assert!(guard.try_acquire().is_ok());
        }
        assert!(guard.try_acquire().is_err());
    }

    #[test]
    fn refresh_guard_resets_after_60_seconds_simulated() {
        let mut guard = RefreshGuard::new();
        for _ in 0..5 {
            guard.try_acquire().ok();
        }
        // 창을 강제로 60초 이전으로 이동
        guard.window_start_mono = Instant::now()
            .checked_sub(std::time::Duration::from_secs(61))
            .unwrap_or_else(Instant::now);
        // 재획득 가능해야 함
        assert!(guard.try_acquire().is_ok());
    }

    #[test]
    fn refresh_guard_drift_resets_on_sleep_wake() {
        let mut guard = RefreshGuard::new();
        for _ in 0..5 {
            guard.try_acquire().ok();
        }
        // wall time을 3분 뒤로 시뮬레이션
        let future_wall = SystemTime::now() + std::time::Duration::from_secs(180);
        guard.reset_if_drift(future_wall);
        assert_eq!(guard.count, 0);
    }
}
