use serde::{Deserialize, Serialize};
use std::fs;
use std::sync::RwLock;
use std::time::Duration;
use tauri::command;

use super::auth::{AuthError, AuthStore};

// --- reqwest Client 래퍼 (Tauri State로 관리) ---

pub struct HttpClient(pub reqwest::Client);

impl HttpClient {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .expect("HTTP 클라이언트 생성 실패");
        Self(client)
    }
}

// --- 캐시 + 폴링 알림 State ---

pub struct LastUsageCache(pub RwLock<Option<UsageEnvelope>>);

pub struct PollNotify(pub tokio::sync::Notify);

// --- 기존 파일 기반 데이터 (fallback용) ---

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct RateLimitData {
    pub rate_limits: Option<serde_json::Value>,
    pub model: Option<serde_json::Value>,
    pub context_window: Option<serde_json::Value>,
    pub updated_at: Option<String>,
}

#[command]
pub fn read_rate_limits() -> Result<RateLimitData, String> {
    let path = dirs::home_dir()
        .ok_or("Failed to get home directory")?
        .join(".claude")
        .join("cache")
        .join("rate-limits.json");

    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read rate limits file: {}. Make sure Claude Code is running.", e))?;

    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse rate limits: {}", e))
}

/// mtime이 max_age_secs 이내인 경우만 데이터 반환. 파일 없거나 stale이면 Ok(None).
pub fn read_rate_limits_if_fresh(max_age_secs: u64) -> Result<Option<RateLimitData>, String> {
    let path = dirs::home_dir()
        .ok_or("Failed to get home directory")?
        .join(".claude")
        .join("cache")
        .join("rate-limits.json");

    let metadata = match fs::metadata(&path) {
        Err(_) => return Ok(None),
        Ok(m) => m,
    };

    let mtime = metadata
        .modified()
        .map_err(|e| format!("mtime 읽기 실패: {}", e))?;

    let age = std::time::SystemTime::now()
        .duration_since(mtime)
        .unwrap_or(std::time::Duration::from_secs(u64::MAX));

    if age.as_secs() > max_age_secs {
        return Ok(None);
    }

    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read rate limits file: {}", e))?;

    let data = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse rate limits: {}", e))?;

    Ok(Some(data))
}

// --- UsageError enum ---

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", content = "data")]
pub enum UsageError {
    TokenMissing,
    TokenExpired,
    NetworkError(String),
    RateLimitHeaderMissing { status: u16 },
    UnexpectedStatus { status: u16, body_snippet: String },
    RefreshRateLimited,
}

impl From<AuthError> for UsageError {
    fn from(e: AuthError) -> Self {
        match e {
            AuthError::NotLoggedIn => UsageError::TokenMissing,
            AuthError::RefreshRateLimited => UsageError::RefreshRateLimited,
            _ => UsageError::TokenExpired,
        }
    }
}

// --- OAuth API 기반 데이터 ---

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UsageWindow {
    pub utilization: Option<f64>,
    pub resets_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExtraUsage {
    pub is_enabled: Option<bool>,
    pub monthly_limit: Option<f64>,
    pub used_credits: Option<f64>,
    pub utilization: Option<f64>,
}

#[derive(Debug, Serialize, Clone)]
pub struct UsageApiResponse {
    pub five_hour: Option<UsageWindow>,
    pub seven_day: Option<UsageWindow>,
    pub seven_day_sonnet: Option<UsageWindow>,
    pub seven_day_opus: Option<UsageWindow>,
    pub extra_usage: Option<ExtraUsage>,
    pub source: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct UsageEnvelope {
    pub seq: u64,
    pub data: UsageApiResponse,
    pub received_at: String,
}

async fn do_haiku_request(
    client: &reqwest::Client,
    token: &str,
) -> Result<reqwest::Response, UsageError> {
    let body = serde_json::json!({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "."}]
    });

    client
        .post("https://api.anthropic.com/v1/messages")
        .header("Authorization", format!("Bearer {}", token))
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| UsageError::NetworkError(e.to_string()))
}

fn parse_usage_response(resp: reqwest::Response) -> impl std::future::Future<Output = Result<UsageApiResponse, UsageError>> {
    async move {
        let status = resp.status();

        if !status.is_success() && status != reqwest::StatusCode::from_u16(207).unwrap() {
            let body_text = resp.text().await.unwrap_or_default();
            let snippet: String = body_text.chars().take(100).collect();
            return Err(UsageError::UnexpectedStatus {
                status: status.as_u16(),
                body_snippet: snippet,
            });
        }

        let headers = resp.headers().clone();
        let _ = resp.text().await;

        let get_header = |name: &str| -> Option<String> {
            headers.get(name).and_then(|v| v.to_str().ok()).map(|s| s.to_string())
        };

        let parse_utilization = |name: &str| -> Option<f64> {
            get_header(name).and_then(|v| v.parse::<f64>().ok()).map(|v| v * 100.0)
        };

        let parse_reset = |name: &str| -> Option<String> {
            get_header(name)
                .and_then(|v| v.parse::<i64>().ok())
                .and_then(|ts| chrono::DateTime::from_timestamp(ts, 0))
                .map(|dt| dt.to_rfc3339())
        };

        let five_hour_util = parse_utilization("anthropic-ratelimit-unified-5h-utilization");
        let seven_day_util = parse_utilization("anthropic-ratelimit-unified-7d-utilization");

        if five_hour_util.is_none() && seven_day_util.is_none() {
            return Err(UsageError::RateLimitHeaderMissing { status: status.as_u16() });
        }

        let now = chrono::Utc::now().to_rfc3339();

        Ok(UsageApiResponse {
            five_hour: Some(UsageWindow {
                utilization: five_hour_util,
                resets_at: parse_reset("anthropic-ratelimit-unified-5h-reset"),
            }),
            seven_day: Some(UsageWindow {
                utilization: seven_day_util,
                resets_at: parse_reset("anthropic-ratelimit-unified-7d-reset"),
            }),
            seven_day_sonnet: None,
            seven_day_opus: None,
            extra_usage: None,
            source: "api".to_string(),
            updated_at: now,
        })
    }
}

/// Haiku에 최소 요청을 보내고 응답 헤더에서 rate limit 정보를 추출
pub async fn fetch_usage_data(
    client: &reqwest::Client,
    auth_store: &AuthStore,
) -> Result<UsageApiResponse, UsageError> {
    let token = auth_store
        .get_valid_access_token()
        .await
        .map_err(UsageError::from)?;

    let resp = do_haiku_request(client, &token).await?;

    // 401 fallback — 1회만 허용
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        let token2 = auth_store
            .force_refresh_now()
            .await
            .map_err(|_| UsageError::TokenExpired)?;
        let resp2 = do_haiku_request(client, &token2).await?;
        if resp2.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(UsageError::TokenExpired);
        }
        return parse_usage_response(resp2).await;
    }

    parse_usage_response(resp).await
}

#[command]
pub async fn fetch_usage_api(
    client: tauri::State<'_, HttpClient>,
    auth_store: tauri::State<'_, AuthStore>,
) -> Result<UsageApiResponse, UsageError> {
    fetch_usage_data(&client.0, &auth_store).await
}

#[command]
pub fn force_refresh(notify: tauri::State<'_, PollNotify>) {
    notify.0.notify_one();
}

#[command]
pub fn get_last_usage(cache: tauri::State<'_, LastUsageCache>) -> Option<UsageEnvelope> {
    cache.0.read().unwrap().clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    #[test]
    fn fresh_file_returns_some() {
        let path = std::path::PathBuf::from("/tmp/__cc_usage_test_fresh__.json");
        {
            let mut f = fs::File::create(&path).unwrap();
            write!(f, r#"{{"rate_limits":null,"model":null,"context_window":null,"updated_at":null}}"#).unwrap();
        }
        let meta = fs::metadata(&path).unwrap();
        let age = std::time::SystemTime::now()
            .duration_since(meta.modified().unwrap())
            .unwrap_or_default();
        let _ = fs::remove_file(&path);
        assert!(age.as_secs() < 300, "newly created file should be fresh");
    }

    #[test]
    fn stale_threshold_logic() {
        let now = std::time::SystemTime::now();
        let six_min_ago = now - std::time::Duration::from_secs(360);
        let age = now.duration_since(six_min_ago).unwrap();
        assert!(age.as_secs() > 300, "6-minute age should exceed 300s threshold");
    }

    #[test]
    fn missing_file_returns_none() {
        let path = std::path::Path::new("/tmp/__nonexistent_cc_usage_test__.json");
        let _ = fs::remove_file(path);
        let meta = fs::metadata(path);
        assert!(meta.is_err(), "nonexistent file should have no metadata");
    }
}
