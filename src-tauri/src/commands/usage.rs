use serde::{Deserialize, Serialize};
use std::fs;
use tauri::command;

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
