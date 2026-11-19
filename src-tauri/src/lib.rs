mod library;
mod models;
mod monitors;
mod overlay;
mod platforms;
mod settings;
mod tray;
mod update;
mod window;

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 이미 켜져 있을 때 다시 실행하면(시작 메뉴·Finder) 캐릭터를 하나 더 띄우지 않고 설정 창을 연다.
        // 메뉴 막대 아이콘이 없어서, 캐릭터가 없을 때(모델 없음·화면 밖) 앱으로 들어오는 길이 이것뿐이다.
        .plugin(tauri_plugin_single_instance::init(|app, _arguments, _cwd| window::open_settings(app)))
        .plugin(tauri_plugin_dialog::init())
        // 로그인할 때 자동 시작 (Windows: 레지스트리 Run, macOS: LaunchAgent). 켜고 끄는 건 설정 창에서.
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .register_asynchronous_uri_scheme_protocol("mate", models::handle_protocol)
        .invoke_handler(tauri::generate_handler![
            overlay::set_interest_rect,
            overlay::set_click_through,
            overlay::mouse_pressed,
            overlay::stage_info,
            overlay::transfer_monitor,
            platforms::set_platform_rate,
            platforms::fullscreen_state,
            platforms::current_windows,
            models::list_models,
            models::save_model_cache,
            models::save_profile,
            models::save_thumbnail,
            settings::update_settings,
            window::open_settings_window,
            window::import_models,
            window::open_models_folder,
            window::open_data_folder,
            window::reload_character,
            window::quit_app,
            models::clear_model_cache,
            models::delete_models,
            library::get_library,
            library::save_library,
            settings::get_settings,
            settings::select_model,
            update::check_for_update,
            update::install_update,
            update::open_update_page,
            launch_options,
            diag,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(settings::SettingsState(Mutex::new(settings::load(&handle))));

            // `screenmate --import <폴더> [<폴더> ...]`: 시작할 때 폴더를 가져온다.
            for folder in import_arguments() {
                match models::import_folder(&handle, &folder) {
                    Ok(imported) => println!("imported {} model(s) from {}", imported.len(), folder.display()),
                    Err(message) => eprintln!("import failed for {}: {message}", folder.display()),
                }
            }
            ensure_selection(&handle);

            let window = app.get_webview_window("main").expect("main window is missing");
            overlay::install(&handle, &window)?;
            platforms::install(&handle);
            window.show()?;
            // 처음 켰거나(안내를 보여 준다) 모델이 하나도 없으면(화면에 캐릭터가 없다) 설정 창을 연다.
            // `--settings`는 개발·확인용으로 늘 연다.
            let onboarded = handle.state::<settings::SettingsState>().0.lock().unwrap().onboarded;
            let no_models = models::load_registry(&handle).is_empty();
            if !onboarded || no_models || std::env::args().any(|argument| argument == "--settings") {
                window::open_settings(&handle);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // macOS: 켜져 있는 앱의 Dock 아이콘을 누르거나 다시 열면 설정 창을 연다
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                window::open_settings(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}

/// 웹뷰 진단 로그를 표준 출력으로 (개발 중 성능 측정용)
#[tauri::command]
fn diag(message: String) {
    println!("diag {message}");
}

#[derive(serde::Serialize)]
struct LaunchOptions {
    /// `--motion <이름>`: 시작할 때 재생할 모션 (미리보기·검증용)
    motion: Option<String>,
    /// `--bench-idle`: 커서를 무시하고 대기 fps로 고정 (성능 측정용)
    #[serde(rename = "benchIdle")]
    bench_idle: bool,
    /// `--drop-on-window`: 창 발판이 잡히면 가장 넓은 창 위에서 떨어뜨린다 (M5 검증용)
    #[serde(rename = "dropOnWindow")]
    drop_on_window: bool,
    /// `--demo-hang`: 가상 커서로 잡아 좌우로 흔든다 (매달리기 흔들림 확인용)
    #[serde(rename = "demoHang")]
    demo_hang: bool,
    /// `--backdrop`: 캐릭터 캔버스 뒤에 단색 배경 (화면 캡처 검증 때 다른 창이 섞이지 않게)
    backdrop: bool,
}

#[tauri::command]
fn launch_options() -> LaunchOptions {
    let arguments: Vec<String> = std::env::args().collect();
    let motion = arguments
        .iter()
        .position(|argument| argument == "--motion")
        .and_then(|index| arguments.get(index + 1).cloned());
    let bench_idle = arguments.iter().any(|argument| argument == "--bench-idle");
    let drop_on_window = arguments.iter().any(|argument| argument == "--drop-on-window");
    let demo_hang = arguments.iter().any(|argument| argument == "--demo-hang");
    let backdrop = arguments.iter().any(|argument| argument == "--backdrop");
    LaunchOptions { motion, bench_idle, drop_on_window, demo_hang, backdrop }
}

fn import_arguments() -> Vec<PathBuf> {
    let mut folders = Vec::new();
    let mut arguments = std::env::args().skip(1);
    while let Some(argument) = arguments.next() {
        if argument == "--import" {
            folders.extend(arguments.by_ref().take_while(|next| !next.starts_with("--")).map(PathBuf::from));
        }
    }
    folders
}

/// 선택된 모델이 없거나 지워졌으면 첫 모델을 고른다.
pub(crate) fn ensure_selection(app: &tauri::AppHandle) {
    let registry = models::load_registry(app);
    let current = app.state::<settings::SettingsState>().0.lock().unwrap().model_id.clone();
    let valid = current.as_ref().is_some_and(|id| registry.iter().any(|entry| &entry.id == id));
    if !valid {
        let first = registry.first().map(|entry| entry.id.clone());
        let _ = settings::update(app, |settings| settings.model_id = first);
    }
}
