// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use commands::usage::{read_rate_limits, fetch_usage_api, HttpClient};
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
                .icon(tauri::image::Image::new_owned(vec![0u8; 4], 1, 1))
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
