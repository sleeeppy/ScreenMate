//! 설정 창에서 쓰는 폴더 열기·모델 가져오기.
//! 메뉴 막대 아이콘은 두지 않는다. 설정과 종료는 설정 창과 캐릭터 우클릭 메뉴에서 한다.

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::models;
use crate::settings;

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
