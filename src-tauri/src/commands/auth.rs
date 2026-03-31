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

pub fn get_oauth_token() -> Result<String, String> {
    // 1차: macOS Keychain에서 읽기
    if let Ok(token) = read_from_keychain() {
        return Ok(token);
    }

    // 2차: ~/.claude/.credentials.json fallback
    if let Ok(token) = read_from_credentials_file() {
        return Ok(token);
    }

    Err("OAuth 토큰을 찾을 수 없습니다. Claude Code에 로그인되어 있는지 확인하세요.".into())
}

fn read_from_keychain() -> Result<String, String> {
    let output = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
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
