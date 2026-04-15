// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use commands::auth::{auth_exchange, auth_logout, auth_start, auth_status, AuthStore};
use commands::usage::{
    fetch_usage_api, fetch_usage_data, force_refresh, get_last_usage, read_rate_limits,
    read_rate_limits_if_fresh, HttpClient, LastUsageCache, PollNotify, UsageApiResponse,
    UsageEnvelope,
};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;
use std::time::Duration;
use tauri::tray::TrayIconBuilder;
use tauri::Emitter;
use tauri::Manager;

static USAGE_SEQ: AtomicU64 = AtomicU64::new(0);
static CURRENT_INTERVAL_SECS: AtomicU64 = AtomicU64::new(60);

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

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

fn update_tray_from_data(app_handle: &tauri::AppHandle, data: &UsageApiResponse) {
    let pct = data
        .five_hour
        .as_ref()
        .and_then(|w| w.utilization)
        .unwrap_or(0.0);
    let resets_at = data.five_hour.as_ref().and_then(|w| w.resets_at.clone());
    let title = format_tray_title(pct, resets_at.as_deref());
    if let Some(tray) = app_handle.tray_by_id("cc-usage-tray") {
        let _ = tray.set_title(Some(&title));
    }
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
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .manage(HttpClient::new())
        .manage(LastUsageCache(RwLock::new(None)))
        .manage(PollNotify(tokio::sync::Notify::new()))
        .manage(AuthStore::new())
        .setup(|app| {
            // AuthStore 키체인 로드
            let auth_store = app.state::<AuthStore>();
            tauri::async_runtime::block_on(auth_store.load_from_keychain());

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
                        CURRENT_INTERVAL_SECS.store(15, Ordering::SeqCst);
                        if let Some(notify) = tray.app_handle().try_state::<PollNotify>() {
                            notify.0.notify_one();
                        }
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Intercept window close: hide instead of destroy + 백그라운드 모드 전환
            let window = app.get_webview_window("main").unwrap();
            let window_clone = window.clone();
            let app_handle_for_close = app.handle().clone();
            window.on_window_event(move |event| {
                match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        CURRENT_INTERVAL_SECS.store(60, Ordering::SeqCst);
                        if let Some(notify) = app_handle_for_close.try_state::<PollNotify>() {
                            notify.0.notify_one();
                        }
                        api.prevent_close();
                        let _ = window_clone.hide();
                    }
                    tauri::WindowEvent::Focused(focused) => {
                        let new_secs = if *focused { 15 } else { 60 };
                        CURRENT_INTERVAL_SECS.store(new_secs, Ordering::SeqCst);
                        if let Some(notify) = app_handle_for_close.try_state::<PollNotify>() {
                            notify.0.notify_one();
                        }
                        log::info!("poll_tick source=focused focused={}", focused);
                    }
                    _ => {}
                }
            });

            // 백그라운드 폴링: emit + cache 갱신
            let app_handle = app.handle().clone();
            let client = app.state::<HttpClient>().0.clone();
            let last_cache = app.state::<LastUsageCache>().inner() as *const LastUsageCache;
            let notify = app.state::<PollNotify>().inner() as *const PollNotify;

            // SAFETY: Tauri managed state는 앱 생명주기 동안 유효
            let last_cache = unsafe { &*last_cache };
            let notify = unsafe { &*notify };

            tauri::async_runtime::spawn(async move {
                loop {
                    let auth_store = app_handle.state::<AuthStore>();
                    let res = fetch_usage_data(&client, &auth_store).await;
                    match res {
                        Ok(data) => {
                            let seq = USAGE_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
                            log::info!("fetch_ok seq={} five_hour={:?}", seq, data.five_hour.as_ref().and_then(|w| w.utilization));
                            let env = UsageEnvelope {
                                seq,
                                data: data.clone(),
                                received_at: now_rfc3339(),
                            };
                            *last_cache.0.write().unwrap() = Some(env.clone());
                            update_tray_from_data(&app_handle, &data);
                            let _ = app_handle.emit("usage-updated", &env);
                        }
                        Err(e) => {
                            log::warn!("fetch_err: {:?}", e);
                            let _ = app_handle.emit("usage-error", &e);
                            // 파일 fallback — 5분 stale 가드
                            if let Ok(Some(data)) = read_rate_limits_if_fresh(300) {
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
                                                    let secs = if n < 1e12 {
                                                        n as i64
                                                    } else {
                                                        (n / 1000.0) as i64
                                                    };
                                                    chrono::DateTime::from_timestamp(secs, 0)
                                                        .map(|dt| dt.to_rfc3339())
                                                } else {
                                                    None
                                                }
                                            });
                                        let title =
                                            format_tray_title(pct, resets_at.as_deref());
                                        if let Some(tray) =
                                            app_handle.tray_by_id("cc-usage-tray")
                                        {
                                            let _ = tray.set_title(Some(&title));
                                        }
                                    }
                                }
                            }
                        }
                    }

                    let interval_secs = CURRENT_INTERVAL_SECS.load(Ordering::SeqCst);
                    let interval = Duration::from_secs(interval_secs);
                    log::info!("poll_tick interval={}s source=interval", interval_secs);
                    tokio::select! {
                        _ = tokio::time::sleep(interval) => {},
                        _ = notify.0.notified() => {
                            log::info!("poll_tick source=notify_or_force");
                        },
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_rate_limits,
            fetch_usage_api,
            update_tray,
            force_refresh,
            get_last_usage,
            auth_status,
            auth_start,
            auth_exchange,
            auth_logout,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
