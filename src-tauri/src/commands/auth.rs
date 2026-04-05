use serde::Deserialize;
use std::process::Command;

#[derive(Deserialize)]
struct Credentials {
    #[serde(rename = "claudeAiOauth")]
    claude_ai_oauth: OAuthTokens,
}

#[derive(Deserialize)]
struct OAuthTokens {
    #[serde(rename = "accessToken")]
    access_token: String,
}

const CLI_KEYCHAIN_SERVICE: &str = "Claude Code-credentials";

/// Keychain 또는 credentials 파일에서 OAuth 토큰 읽기
pub fn get_oauth_token() -> Result<String, String> {
    if let Ok(token) = read_token_from_keychain(CLI_KEYCHAIN_SERVICE) {
        return Ok(token);
    }
    if let Ok(token) = read_from_credentials_file() {
        return Ok(token);
    }
    Err("OAuth 토큰을 찾을 수 없습니다. 터미널에서 claude 명령어로 로그인하세요.".into())
}

fn read_token_from_keychain(service: &str) -> Result<String, String> {
    let output = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", service, "-w"])
        .output()
        .map_err(|e| format!("Keychain 명령 실행 실패: {}", e))?;

    if !output.status.success() {
        return Err("Keychain에서 토큰을 찾을 수 없습니다".into());
    }

    let json_str = String::from_utf8(output.stdout)
        .map_err(|e| format!("Keychain 데이터 파싱 실패: {}", e))?;

    let creds: Credentials = serde_json::from_str(json_str.trim())
        .map_err(|e| format!("Keychain JSON 파싱 실패: {}", e))?;

    Ok(creds.claude_ai_oauth.access_token)
}

fn read_from_credentials_file() -> Result<String, String> {
    let path = dirs::home_dir()
        .ok_or("홈 디렉토리를 찾을 수 없습니다")?
        .join(".claude")
        .join(".credentials.json");

    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("credentials.json 읽기 실패: {}", e))?;

    let creds: Credentials = serde_json::from_str(&content)
        .map_err(|e| format!("credentials.json 파싱 실패: {}", e))?;

    Ok(creds.claude_ai_oauth.access_token)
}
