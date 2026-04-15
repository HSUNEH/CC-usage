use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use once_cell::sync::Lazy;
use rand::RngCore;
use regex::Regex;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fmt;
use zeroize::ZeroizeOnDrop;

static SANITIZE_PATTERNS: Lazy<Vec<Regex>> = Lazy::new(|| {
    vec![
        // snake_case key=value (quote in character class needs no backslash in raw string)
        Regex::new(r#"(access_token|refresh_token|code|code_verifier|id_token|client_secret)=[^&\s"]*"#).unwrap(),
        // camelCase JSON "key": "value"
        Regex::new(r#""(accessToken|refreshToken|codeVerifier|idToken|clientSecret)"\s*:\s*"[^"]*""#).unwrap(),
        // URL-encoded key%3Dvalue
        Regex::new(r#"(access_token|refresh_token)%3D[^&\s"]*"#).unwrap(),
        // Anthropic API key
        Regex::new(r"sk-ant-[A-Za-z0-9_-]+").unwrap(),
        // JWT  (dots escaped with backslash — valid in raw string)
        Regex::new(r"eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+").unwrap(),
        // 64-hex token
        Regex::new(r"[A-Fa-f0-9]{64}").unwrap(),
    ]
});

#[derive(Clone)]
pub struct SanitizedBody(pub String);

impl SanitizedBody {
    pub fn new(raw: &str) -> Self {
        let mut result = raw.to_string();
        for re in SANITIZE_PATTERNS.iter() {
            result = re
                .replace_all(&result, |caps: &regex::Captures| {
                    let full = &caps[0];
                    if let Some(eq_pos) = full.find('=') {
                        format!("{}=<redacted>", &full[..eq_pos])
                    } else if full.starts_with('"') {
                        // camelCase JSON: "key": "value"
                        let colon_pos = full.find(':').unwrap_or(full.len());
                        format!("{}: \"<redacted>\"", &full[..colon_pos])
                    } else {
                        "<redacted>".to_string()
                    }
                })
                .to_string();
        }
        Self(result)
    }
}

impl fmt::Debug for SanitizedBody {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SanitizedBody({})", self.0)
    }
}

impl fmt::Display for SanitizedBody {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl serde::Serialize for SanitizedBody {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0)
    }
}

#[derive(Debug, serde::Serialize)]
pub enum OAuthError {
    Network(String),
    HttpStatus { status: u16, hint: SanitizedBody },
    Parse(String),
    StateMismatch,
}

impl fmt::Display for OAuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OAuthError::Network(e) => write!(f, "network error: {}", e),
            OAuthError::HttpStatus { status, hint } => write!(f, "HTTP {}: {}", status, hint),
            OAuthError::Parse(e) => write!(f, "parse error: {}", e),
            OAuthError::StateMismatch => write!(f, "state mismatch"),
        }
    }
}

/// Deserialization-only DTO — move-converted to TokenResponse immediately
#[derive(Deserialize)]
struct RawTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

#[derive(ZeroizeOnDrop)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    #[zeroize(skip)]
    pub expires_in: Option<u64>,
}

impl fmt::Debug for TokenResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TokenResponse")
            .field("access_token", &"<redacted>")
            .field("refresh_token", &"<redacted>")
            .field("expires_in", &self.expires_in)
            .finish()
    }
}

pub fn generate_pkce_pair() -> (String, String) {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let verifier = URL_SAFE_NO_PAD.encode(&bytes);
    let digest = Sha256::digest(verifier.as_bytes());
    let challenge = URL_SAFE_NO_PAD.encode(&digest);
    (verifier, challenge)
}

pub fn build_authorize_url(challenge: &str, state: &str, scope: &str) -> String {
    fn enc(s: &str) -> String {
        let mut out = String::new();
        for b in s.as_bytes() {
            match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
                b' ' => out.push('+'),
                _ => out.push_str(&format!("%{:02X}", b)),
            }
        }
        out
    }
    format!(
        "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&scope={}&code_challenge={}&code_challenge_method=S256&state={}",
        enc(scope), enc(challenge), enc(state)
    )
}

pub async fn exchange_code(
    code: &str,
    verifier: &str,
    state: &str,
) -> Result<TokenResponse, OAuthError> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "grant_type": "authorization_code",
        "code": code,
        "state": state,
        "code_verifier": verifier,
        "redirect_uri": "https://console.anthropic.com/oauth/code/callback",
        "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    });

    let resp = client
        .post("https://console.anthropic.com/v1/oauth/token")
        .header("content-type", "application/json")
        .header("anthropic-beta", "oauth-2025-04-20")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| OAuthError::Network(e.to_string()))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(OAuthError::HttpStatus {
            status: status.as_u16(),
            hint: SanitizedBody::new(&body),
        });
    }

    let raw: RawTokenResponse = resp
        .json()
        .await
        .map_err(|e| OAuthError::Parse(e.to_string()))?;

    Ok(TokenResponse {
        access_token: raw.access_token,
        refresh_token: raw.refresh_token,
        expires_in: raw.expires_in,
    })
}

pub async fn refresh_access_token(refresh: &str) -> Result<TokenResponse, OAuthError> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "grant_type": "refresh_token",
        "refresh_token": refresh,
        "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    });

    let resp = client
        .post("https://console.anthropic.com/v1/oauth/token")
        .header("content-type", "application/json")
        .header("anthropic-beta", "oauth-2025-04-20")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| OAuthError::Network(e.to_string()))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(OAuthError::HttpStatus {
            status: status.as_u16(),
            hint: SanitizedBody::new(&body),
        });
    }

    let raw: RawTokenResponse = resp
        .json()
        .await
        .map_err(|e| OAuthError::Parse(e.to_string()))?;

    Ok(TokenResponse {
        access_token: raw.access_token,
        refresh_token: raw.refresh_token,
        expires_in: raw.expires_in,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_pkce_pair_produces_valid_pair() {
        let (verifier, challenge) = generate_pkce_pair();
        assert!(!verifier.is_empty());
        assert!(!challenge.is_empty());
        assert_ne!(verifier, challenge);
        let digest = Sha256::digest(verifier.as_bytes());
        let expected = URL_SAFE_NO_PAD.encode(&digest);
        assert_eq!(challenge, expected);
    }

    #[test]
    fn generate_pkce_pair_is_unique() {
        let (v1, _) = generate_pkce_pair();
        let (v2, _) = generate_pkce_pair();
        assert_ne!(v1, v2);
    }

    #[test]
    fn sanitized_body_masks_snake_case_access_token() {
        let raw = "access_token=supersecret123&foo=bar";
        let s = SanitizedBody::new(raw);
        assert!(!s.0.contains("supersecret123"));
        assert!(s.0.contains("access_token=<redacted>"));
        assert!(s.0.contains("foo=bar"));
    }

    #[test]
    fn sanitized_body_masks_camel_case_json() {
        let raw = r#"{"accessToken": "mytoken123", "other": "val"}"#;
        let s = SanitizedBody::new(raw);
        assert!(!s.0.contains("mytoken123"));
    }

    #[test]
    fn sanitized_body_masks_jwt() {
        let raw = "token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abcdef123456789012345678901234567";
        let s = SanitizedBody::new(raw);
        assert!(!s.0.contains("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abcdef123456789012345678901234567"));
    }

    #[test]
    fn sanitized_body_masks_64hex() {
        let hex64 = "a".repeat(64);
        let raw = format!("hash={}", hex64);
        let s = SanitizedBody::new(&raw);
        assert!(!s.0.contains(&hex64));
    }

    #[test]
    fn sanitized_body_masks_sk_ant_key() {
        let raw = "key=sk-ant-SomeApiKeyHere123";
        let s = SanitizedBody::new(raw);
        assert!(!s.0.contains("sk-ant-SomeApiKeyHere123"));
    }

    #[test]
    fn sanitized_body_preserves_non_sensitive() {
        let raw = "error=invalid_grant&error_description=expired";
        let s = SanitizedBody::new(raw);
        assert!(s.0.contains("error=invalid_grant"));
        assert!(s.0.contains("error_description=expired"));
    }
}
