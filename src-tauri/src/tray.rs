//! 트레이 메뉴: 설정 창 열기, 모델 전환, 가져오기, 크기, 종료.

use std::collections::BTreeMap;

use tauri::menu::{
    CheckMenuItemBuilder, Menu, MenuBuilder, MenuEvent, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::models::{self, ModelEntry};
use crate::settings::{self, SettingsState};

const TRAY_ID: &str = "main";

/// 웹뷰가 알려준 모션 목록 (트레이 "모션 미리보기" 메뉴)
#[derive(Clone, serde::Deserialize)]
pub struct MotionItem {
    name: String,
    label: String,
}

#[derive(Default)]
pub struct MotionMenu {
    items: std::sync::Mutex<Vec<MotionItem>>,
    current: std::sync::Mutex<Option<String>>,
}

#[tauri::command]
pub fn register_motions(app: AppHandle, items: Vec<MotionItem>, current: Option<String>) {
    let state = app.state::<MotionMenu>();
    *state.items.lock().unwrap() = items;
    *state.current.lock().unwrap() = current;
    refresh(&app);
}
const SIZES: &[(&str, f64)] = &[("작게", 200.0), ("보통", 260.0), ("크게", 340.0)];

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/trayTemplate.png"))?;
    TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("ScreenMate")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .icon(icon)
        .icon_as_template(true)
        .on_menu_event(on_menu_event)
        .build(app)?;
    Ok(())
}

/// 모델 목록이나 선택이 바뀌었을 때 메뉴를 다시 만든다.
pub fn refresh(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    if let Ok(menu) = build_menu(app) {
        let _ = tray.set_menu(Some(menu));
    }
}

/// 폴더 하나를 하위 메뉴로 (안에 모델이 하나도 없으면 None). 너무 깊으면 그만 내려간다.
fn folder_menu(
    app: &AppHandle,
    library: &crate::library::Library,
    models: &[ModelEntry],
    folder: &crate::library::Folder,
    check: &dyn Fn(&ModelEntry) -> tauri::Result<tauri::menu::CheckMenuItem<Wry>>,
    depth: usize,
) -> tauri::Result<Option<tauri::menu::Submenu<Wry>>> {
    if depth > 8 {
        return Ok(None);
    }
    let mut submenu = SubmenuBuilder::new(app, &folder.name);
    let mut empty = true;
    for child in library.folders.iter().filter(|child| child.parent.as_deref() == Some(folder.id.as_str())) {
        if let Some(inner) = folder_menu(app, library, models, child, check, depth + 1)? {
            submenu = submenu.item(&inner);
            empty = false;
        }
    }
    for entry in models.iter().filter(|entry| library.placement.get(&entry.id) == Some(&Some(folder.id.clone()))) {
        submenu = submenu.item(&check(entry)?);
        empty = false;
    }
    if empty {
        return Ok(None);
    }
    Ok(Some(submenu.build()?))
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let settings = app.state::<SettingsState>().0.lock().unwrap().clone();
    let models = models::load_registry(app);
    let mut library = crate::library::load(app);
    library.prune(&models);

    let mut menu = MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id("settings", "설정…").accelerator("CmdOrCtrl+,").build(app)?)
        .item(&PredefinedMenuItem::separator(app)?);
    if models.is_empty() {
        menu = menu.item(&MenuItemBuilder::with_id("none", "가져온 모델 없음").enabled(false).build(app)?);
    }

    // 설정 창에서 정리한 대로: 폴더는 하위 메뉴, 폴더 밖 모델은 바로. 이름은 바꾼 이름.
    // 아직 정리 전이면(설정 창을 한 번도 안 염) 가져온 폴더 이름으로 묶는다.
    let check = |entry: &ModelEntry| {
        CheckMenuItemBuilder::with_id(format!("model:{}", entry.id), library.title_of(entry))
            .checked(settings.model_id.as_deref() == Some(entry.id.as_str()))
            .build(app)
    };
    let mut groups: Vec<(String, Vec<&ModelEntry>)> = Vec::new();
    let mut loose: Vec<&ModelEntry> = Vec::new();
    if library.organized {
        // 폴더 안 폴더는 하위 메뉴 안의 하위 메뉴
        for folder in library.folders.iter().filter(|folder| folder.parent.is_none()) {
            if let Some(submenu) = folder_menu(app, &library, &models, folder, &check, 0)? {
                menu = menu.item(&submenu);
            }
        }
        loose = models
            .iter()
            .filter(|entry| !matches!(library.placement.get(&entry.id), Some(Some(_))))
            .collect();
    } else {
        let mut by_group: BTreeMap<String, Vec<&ModelEntry>> = BTreeMap::new();
        for entry in &models {
            by_group.entry(entry.group.clone()).or_default().push(entry);
        }
        for (group, entries) in by_group {
            if entries.len() == 1 {
                loose.push(entries[0]);
            } else {
                groups.push((group, entries));
            }
        }
    }
    for (name, entries) in &groups {
        let mut submenu = SubmenuBuilder::new(app, name);
        for entry in entries {
            submenu = submenu.item(&check(entry)?);
        }
        menu = menu.item(&submenu.build()?);
    }
    for entry in loose {
        menu = menu.item(&check(entry)?);
    }

    let mut size = SubmenuBuilder::new(app, "크기");
    for (label, height) in SIZES {
        size = size.item(
            &CheckMenuItemBuilder::with_id(format!("size:{height}"), *label)
                .checked((settings.height_px - height).abs() < 0.5)
                .build(app)?,
        );
    }

    let motions = app.state::<MotionMenu>();
    let current_motion = motions.current.lock().unwrap().clone();
    let mut preview = SubmenuBuilder::new(app, "모션 미리보기");
    for item in motions.items.lock().unwrap().iter() {
        preview = preview.item(
            &CheckMenuItemBuilder::with_id(format!("motion:{}", item.name), &item.label)
                .checked(current_motion.as_deref() == Some(item.name.as_str()))
                .build(app)?,
        );
    }

    menu.item(&PredefinedMenuItem::separator(app)?)
        .item(&preview.build()?)
        .item(&MenuItemBuilder::with_id("import", "모델 가져오기…").build(app)?)
        .item(&MenuItemBuilder::with_id("open-folder", "모델 폴더 열기").build(app)?)
        .item(&size.build()?)
        .item(&MenuItemBuilder::with_id("reload", "다시 불러오기").build(app)?)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&MenuItemBuilder::with_id("quit", "종료").build(app)?)
        .build()
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    if let Some(motion) = id.strip_prefix("motion:") {
        let _ = app.emit("motion-preview", motion);
    } else if let Some(model_id) = id.strip_prefix("model:") {
        let _ = settings::select_model(app.clone(), model_id.to_string());
    } else if let Some(height) = id.strip_prefix("size:").and_then(|value| value.parse::<f64>().ok()) {
        let _ = settings::update(app, |settings| settings.height_px = height);
        refresh(app);
    } else {
        match id {
            "settings" => crate::window::open_settings(app),
            "import" => pick_and_import(app),
            "open-folder" => open_folder(app, "models"),
            "reload" => {
                let _ = app.emit("reload", ());
            }
            "quit" => app.exit(0),
            _ => {}
        }
    }
}

/// 앱 데이터 폴더(또는 그 안의 하위 폴더)를 파일 관리자로 연다.
pub fn open_folder(app: &AppHandle, sub: &str) {
    if let Ok(root) = models::data_root(app) {
        let folder = if sub.is_empty() { root } else { root.join(sub) };
        let _ = std::fs::create_dir_all(&folder);
        let opener = if cfg!(windows) { "explorer" } else if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        let _ = std::process::Command::new(opener).arg(folder).spawn();
    }
}

pub fn pick_and_import(app: &AppHandle) {
    let handle = app.clone();
    app.dialog()
        .file()
        .set_title("MMD 모델 폴더 선택 (.pmx / .pmd가 들어 있는 폴더)")
        .pick_folder(move |folder| {
            let Some(path) = folder.and_then(|folder| folder.into_path().ok()) else {
                return;
            };
            match models::import_folder(&handle, &path) {
                Ok(imported) => {
                    if let Some(first) = imported.first() {
                        let _ = settings::select_model(handle.clone(), first.id.clone());
                    }
                    refresh(&handle);
                }
                Err(message) => {
                    handle
                        .dialog()
                        .message(message)
                        .title("모델 가져오기 실패")
                        .kind(MessageDialogKind::Error)
                        .show(|_| {});
                }
            }
        });
}
