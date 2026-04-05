use serde::{Deserialize, Serialize};
use std::fs;
use std::time::Duration;
use tauri::command;

use super::auth;

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

/// Haiku에 최소 요청을 보내고 응답 헤더에서 rate limit 정보를 추출
pub async fn fetch_usage_data(client: &reqwest::Client) -> Result<UsageApiResponse, String> {
    let token = tokio::task::spawn_blocking(auth::get_oauth_token)
        .await
        .map_err(|e| format!("토큰 획득 태스크 실패: {}", e))?
        .map_err(|e| format!("token_error: {}", e))?;

    let body = serde_json::json!({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "."}]
    });

    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("Authorization", format!("Bearer {}", token))
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("API 요청 실패: {}", e))?;

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("auth_expired: OAuth 토큰이 만료되었습니다. Claude Code에 다시 로그인하세요.".into());
    }

    let headers = resp.headers().clone();

    // 헤더에서 rate limit 정보 추출 (응답 본문은 무시)
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

    // 헤더가 전혀 없으면 에러
    if five_hour_util.is_none() && seven_day_util.is_none() {
        return Err(format!("api_error: rate limit 헤더 없음 (HTTP {})", status.as_u16()));
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

#[command]
pub async fn fetch_usage_api(
    client: tauri::State<'_, HttpClient>,
) -> Result<UsageApiResponse, String> {
    fetch_usage_data(&client.0).await
}
