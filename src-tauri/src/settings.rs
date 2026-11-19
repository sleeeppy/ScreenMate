//! 사용자 설정 (%APPDATA%\dev.sleeeppy.screenmate\settings.json)

use std::fs;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_autostart::ManagerExt;

use crate::models::data_root;

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub model_id: Option<String>,
    /// 캐릭터 키(頭 본 높이) CSS px
    pub height_px: f64,
    /// 서 있다가 두리번·기지개·걸터앉기 같은 동작을 섞는다
    pub variety: bool,
    /// 창 위쪽 테두리에 올라서고 앉는다
    pub ledges: bool,
    /// 입력이 없으면 이 시간(분) 뒤에 앉아서 존다. 0이면 졸지 않는다.
    pub sleep_minutes: u32,
    /// 가까이 온 커서를 눈과 고개로 따라본다
    pub gaze: bool,
    /// 캐릭터가 마지막에 있던 모니터 (다음에 켤 때 거기서 시작)
    pub monitor: Option<crate::monitors::MonitorRef>,
    /// 로그인할 때 자동 시작. 실제 값은 운영체제(Windows 레지스트리 Run, macOS LaunchAgent)에 있고 여기엔 비춰 둔다.
    #[serde(skip_deserializing)]
    pub autostart: bool,
    /// 처음 켰을 때 보여 주는 안내(튜토리얼)를 봤다. 이 값이 없는 옛 설정 파일은 이미 쓰던 사람이라 본 것으로 친다.
    #[serde(default = "already_onboarded")]
    pub onboarded: bool,
    /// 마지막으로 실행·확인한 앱 버전. 현재 버전이 이 값보다 높으면 업데이트 직후로 보고 패치노트를 띄운다.
    #[serde(default)]
    pub seen_version: Option<String>,
}

fn already_onboarded() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            model_id: None,
            height_px: 260.0,
            variety: true,
            ledges: true,
            sleep_minutes: 10,
            gaze: true,
            monitor: None,
            autostart: false,
            onboarded: false,
            seen_version: None,
        }
    }
}

/// 설정 창에서 바꾸는 항목 (보낸 것만 바꾼다)
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsPatch {
    pub height_px: Option<f64>,
    pub variety: Option<bool>,
    pub ledges: Option<bool>,
    pub sleep_minutes: Option<u32>,
    pub gaze: Option<bool>,
    pub autostart: Option<bool>,
    pub onboarded: Option<bool>,
    pub seen_version: Option<String>,
}

pub struct SettingsState(pub Mutex<Settings>);

/// 설정 파일을 읽는다. 자동 시작은 운영체제에서 읽는다.
///
/// 설정 파일이 아직 없으면(처음 켬) 설치한 앱에서는 자동 시작을 켠다. 개발 빌드는 빌드 폴더 실행 파일이
/// 로그인 항목에 남으므로 켜지 않는다.
pub fn load<R: Runtime>(app: &AppHandle<R>) -> Settings {
    let file = data_root(app).ok().map(|root| root.join("settings.json"));
    let first_run = file.as_ref().is_some_and(|file| !file.exists());
    let mut settings: Settings = file
        .and_then(|file| fs::read(file).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let current = app.package_info().version.to_string();
    let mut needs_save = false;
    // 처음 설치했거나 seen_version이 없던 예전 설정 파일은 지금 버전을 기록해 두고,
    // 다음 버전으로 업데이트됐을 때부터 패치노트가 뜨게 한다.
    if settings.seen_version.is_none() {
        settings.seen_version = Some(current);
        needs_save = true;
    }
    if first_run && !cfg!(debug_assertions) {
        let _ = app.autolaunch().enable();
        needs_save = true;
    }
    if needs_save && (!first_run || !cfg!(debug_assertions)) {
        let _ = save(app, &settings);
    }
    settings.autostart = app.autolaunch().is_enabled().unwrap_or(false);
    settings
}

fn save<R: Runtime>(app: &AppHandle<R>, settings: &Settings) -> Result<(), String> {
    let root = data_root(app)?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let json = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
    fs::write(root.join("settings.json"), json).map_err(|error| error.to_string())
}

pub fn update<R: Runtime>(app: &AppHandle<R>, change: impl FnOnce(&mut Settings)) -> Result<Settings, String> {
    let state = app.state::<SettingsState>();
    let mut settings = state.0.lock().unwrap();
    change(&mut settings);
    save(app, &settings)?;
    let snapshot = settings.clone();
    drop(settings);
    let _ = app.emit("settings-changed", &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub fn get_settings(state: tauri::State<'_, SettingsState>) -> Settings {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn update_settings(app: AppHandle, patch: SettingsPatch) -> Result<Settings, String> {
    let settings = update(&app, |settings| {
        if let Some(height) = patch.height_px {
            settings.height_px = height.clamp(140.0, 480.0);
        }
        if let Some(variety) = patch.variety {
            settings.variety = variety;
        }
        if let Some(ledges) = patch.ledges {
            settings.ledges = ledges;
        }
        if let Some(minutes) = patch.sleep_minutes {
            settings.sleep_minutes = minutes.min(240);
        }
        if let Some(gaze) = patch.gaze {
            settings.gaze = gaze;
        }
        if let Some(onboarded) = patch.onboarded {
            settings.onboarded = onboarded;
        }
        if let Some(seen) = patch.seen_version {
            settings.seen_version = Some(seen);
        }
        if let Some(enabled) = patch.autostart {
            let launcher = app.autolaunch();
            let result = if enabled { launcher.enable() } else { launcher.disable() };
            if let Err(error) = result {
                eprintln!("autostart {enabled} failed: {error}");
            }
            settings.autostart = launcher.is_enabled().unwrap_or(false);
        }
    })?;
    Ok(settings)
}

#[tauri::command]
pub fn select_model(app: AppHandle, id: String) -> Result<Settings, String> {
    let settings = update(&app, |settings| settings.model_id = Some(id))?;
    Ok(settings)
}
