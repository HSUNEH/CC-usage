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

#[derive(Debug, Deserialize)]
struct ApiResponse {
    five_hour: Option<UsageWindow>,
    seven_day: Option<UsageWindow>,
    seven_day_sonnet: Option<UsageWindow>,
    seven_day_opus: Option<UsageWindow>,
    extra_usage: Option<ExtraUsage>,
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

#[command]
pub async fn fetch_usage_api(
    client: tauri::State<'_, HttpClient>,
) -> Result<UsageApiResponse, String> {
    // blocking I/O (Keychain 접근)를 별도 스레드에서 실행
    let token = tokio::task::spawn_blocking(auth::get_oauth_token)
        .await
        .map_err(|e| format!("토큰 획득 태스크 실패: {}", e))?
        .map_err(|e| format!("token_error: {}", e))?;

    let resp = client
        .0
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", format!("Bearer {}", token))
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
        .map_err(|e| format!("API 요청 실패: {}", e))?;

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("auth_expired: OAuth 토큰이 만료되었습니다. Claude Code에 다시 로그인하세요.".into());
    }
    if !status.is_success() {
        return Err(format!("api_error: HTTP {}", status.as_u16()));
    }

    let api_data: ApiResponse = resp
        .json()
        .await
        .map_err(|e| format!("API 응답 파싱 실패: {}", e))?;

    let now = chrono::Utc::now().to_rfc3339();

    Ok(UsageApiResponse {
        five_hour: api_data.five_hour,
        seven_day: api_data.seven_day,
        seven_day_sonnet: api_data.seven_day_sonnet,
        seven_day_opus: api_data.seven_day_opus,
        extra_usage: api_data.extra_usage,
        source: "api".to_string(),
        updated_at: now,
    })
}
