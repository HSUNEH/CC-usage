// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use commands::usage::{fetch_usage_api, fetch_usage_data, read_rate_limits, HttpClient};
use std::time::Duration;
use tauri::tray::TrayIconBuilder;
use tauri::Manager;

fn format_tray_title(pct: f64, resets_at: Option<&str>) -> String {
    let remaining = if let Some(reset_str) = resets_at {
        if let Ok(reset_time) = chrono::DateTime::parse_from_rfc3339(reset_str) {
            let now = chrono::Utc::now();
            let diff = reset_time.signed_duration_since(now);
            let total_mins = diff.num_minutes().max(0);
            let h = total_mins / 60;
            let m = total_mins % 60;
            if h > 0 {
                format!("{}h{:02}m", h, m)
            } else {
                format!("{}m", m)
            }
        } else {
            "-".to_string()
        }
    } else {
        "-".to_string()
    };

    format!("{} {:.0}%", remaining, pct)
}

#[tauri::command]
fn update_tray(app: tauri::AppHandle, pct: f64, resets_at: Option<String>) {
    let title = format_tray_title(pct, resets_at.as_deref());
    if let Some(tray) = app.tray_by_id("cc-usage-tray") {
        let _ = tray.set_title(Some(&title));
    }
}

fn main() {
    env_logger::init();

    tauri::Builder::default()
        .manage(HttpClient::new())
        .setup(|app| {
            let _tray = TrayIconBuilder::with_id("cc-usage-tray")
                .title("- 0%")
                .tooltip("CC-usage")
                .icon(tauri::image::Image::new(
                    include_bytes!("../icons/tray-claude.rgba"),
                    44,
                    44,
                ))
                .icon_as_template(true)
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { .. } = event {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Intercept window close: hide instead of destroy
            let window = app.get_webview_window("main").unwrap();
            let window_clone = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window_clone.hide();
                }
            });

            // 백그라운드 폴링: 1분마다 트레이 타이틀 업데이트
            let app_handle = app.handle().clone();
            let client = app.state::<HttpClient>().0.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(60)).await;

                    // 1차: Haiku API (헤더에서 rate limit 추출)
                    if let Ok(data) = fetch_usage_data(&client).await {
                        let pct = data
                            .five_hour
                            .as_ref()
                            .and_then(|w| w.utilization)
                            .unwrap_or(0.0);
                        let resets_at =
                            data.five_hour.as_ref().and_then(|w| w.resets_at.clone());
                        let title = format_tray_title(pct, resets_at.as_deref());
                        if let Some(tray) = app_handle.tray_by_id("cc-usage-tray") {
                            let _ = tray.set_title(Some(&title));
                        }
                        continue;
                    }

                    // 2차: 파일 fallback
                    if let Ok(data) = read_rate_limits() {
                        if let Some(rl) = &data.rate_limits {
                            if let Some(fh) = rl.get("five_hour") {
                                let pct = fh
                                    .get("used_percentage")
                                    .and_then(|v| v.as_f64())
                                    .unwrap_or(0.0);
                                let resets_at = fh
                                    .get("resets_at")
                                    .or_else(|| fh.get("reset_at"))
                                    .and_then(|v| {
                                        if let Some(s) = v.as_str() {
                                            Some(s.to_string())
                                        } else if let Some(n) = v.as_f64() {
                                            let secs =
                                                if n < 1e12 { n as i64 } else { (n / 1000.0) as i64 };
                                            chrono::DateTime::from_timestamp(secs, 0)
                                                .map(|dt| dt.to_rfc3339())
                                        } else {
                                            None
                                        }
                                    });
                                let title = format_tray_title(pct, resets_at.as_deref());
                                if let Some(tray) = app_handle.tray_by_id("cc-usage-tray") {
                                    let _ = tray.set_title(Some(&title));
                                }
                            }
                        }
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_rate_limits,
            fetch_usage_api,
            update_tray,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
