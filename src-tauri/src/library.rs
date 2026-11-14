//! 모델 보관함 정리: 사용자가 만든 폴더, 모델이 들어 있는 폴더, 바꾼 이름 (models\library.json).
//!
//! 모델 목록(registry.json)은 다시 가져오면 덮어쓰이므로 정리 정보는 따로 둔다. 모델 id 기준이라 다시 가져와도 그대로다.
//! 폴더를 처음 만들거나 새로 가져온 모델을 어느 폴더에 넣을지는 설정 창(`settings/library.ts`)이 정한다.
//! 여기서는 저장하고, 지운 모델·없는 폴더를 가리키는 값만 정리한다.

use std::collections::BTreeMap;
use std::fs;

use tauri::{AppHandle, Emitter, Runtime};

use crate::models::{data_root, ModelEntry};

#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Folder {
    pub id: String,
    pub name: String,
    /// 상위 폴더 (None이면 맨 위)
    pub parent: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Library {
    /// 처음 정리를 마쳤는지 (아니면 설정 창이 캐릭터별 폴더를 만들어 넣는다)
    pub organized: bool,
    /// 폴더 (보이는 순서)
    pub folders: Vec<Folder>,
    /// 모델 id → 폴더 id. null이면 맨 위(폴더 밖). 키가 없으면 새로 들어온 모델
    pub placement: BTreeMap<String, Option<String>>,
    /// 모델 id → 사용자가 바꾼 이름
    pub titles: BTreeMap<String, String>,
}

impl Library {
    /// 없는 모델·폴더를 가리키는 값을 지운다.
    pub fn prune(&mut self, models: &[ModelEntry]) {
        let known = |id: &String| models.iter().any(|entry| &entry.id == id);
        self.placement.retain(|id, _| known(id));
        self.titles.retain(|id, title| known(id) && !title.trim().is_empty());
        let mut seen = Vec::new();
        self.folders.retain(|folder| {
            let fresh = !folder.id.is_empty() && !seen.contains(&folder.id);
            seen.push(folder.id.clone());
            fresh
        });
        // 없는 상위 폴더를 가리키거나 서로 가리켜 맴도는 폴더는 맨 위로
        let ids: Vec<String> = self.folders.iter().map(|folder| folder.id.clone()).collect();
        let parents: Vec<(String, Option<String>)> =
            self.folders.iter().map(|folder| (folder.id.clone(), folder.parent.clone())).collect();
        for folder in &mut self.folders {
            let Some(parent) = folder.parent.clone() else { continue };
            let mut current = Some(parent);
            let mut steps = 0;
            let mut broken = false;
            while let Some(id) = current {
                if !ids.contains(&id) || id == folder.id || steps > parents.len() {
                    broken = true;
                    break;
                }
                steps += 1;
                current = parents.iter().find(|(candidate, _)| *candidate == id).and_then(|(_, parent)| parent.clone());
            }
            if broken {
                folder.parent = None;
            }
        }
        for target in self.placement.values_mut() {
            if target.as_ref().is_some_and(|id| !self.folders.iter().any(|folder| &folder.id == id)) {
                *target = None;
            }
        }
    }

    pub fn title_of<'a>(&'a self, entry: &'a ModelEntry) -> &'a str {
        self.titles.get(&entry.id).map(String::as_str).unwrap_or(&entry.name)
    }
}

fn path<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, String> {
    Ok(data_root(app)?.join("models").join("library.json"))
}

pub fn load<R: Runtime>(app: &AppHandle<R>) -> Library {
    path(app)
        .ok()
        .and_then(|path| fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub fn save<R: Runtime>(app: &AppHandle<R>, library: &Library) -> Result<(), String> {
    let path = path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let json = serde_json::to_vec_pretty(library).map_err(|error| error.to_string())?;
    fs::write(path, json).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_library(app: AppHandle) -> Library {
    let mut library = load(&app);
    library.prune(&crate::models::load_registry(&app));
    library
}

/// 설정 창에서 정리한 결과를 저장하고 다른 창(트레이 메뉴 포함)에 알린다.
#[tauri::command]
pub fn save_library(app: AppHandle, mut library: Library) -> Result<Library, String> {
    for folder in &mut library.folders {
        folder.name = folder.name.trim().chars().take(60).collect();
    }
    for title in library.titles.values_mut() {
        *title = title.trim().chars().take(80).collect();
    }
    library.prune(&crate::models::load_registry(&app));
    save(&app, &library)?;
    let _ = app.emit("library-changed", &library);
    crate::tray::refresh(&app);
    Ok(library)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str) -> ModelEntry {
        ModelEntry { id: id.into(), name: format!("{id} 이름"), group: "g".into(), file: format!("p/{id}.pmx"), format: "pmx".into() }
    }

    #[test]
    fn prune_drops_deleted_models_and_missing_folders() {
        let mut library = Library {
            organized: true,
            folders: vec![
                Folder { id: "a".into(), name: "A".into(), parent: None },
                Folder { id: "a".into(), name: "중복".into(), parent: None },
                Folder { id: "b".into(), name: "B".into(), parent: Some("gone".into()) },
                Folder { id: "c".into(), name: "C".into(), parent: Some("d".into()) },
                Folder { id: "d".into(), name: "D".into(), parent: Some("c".into()) },
                Folder { id: "e".into(), name: "E".into(), parent: Some("a".into()) },
            ],
            placement: BTreeMap::from([
                ("m1".into(), Some("a".into())),
                ("m2".into(), Some("gone".into())),
                ("deleted".into(), Some("a".into())),
            ]),
            titles: BTreeMap::from([("m1".into(), "린".into()), ("m2".into(), "  ".into()), ("deleted".into(), "x".into())]),
        };
        library.prune(&[entry("m1"), entry("m2")]);
        assert_eq!(library.folders.len(), 5);
        let parent = |id: &str| library.folders.iter().find(|folder| folder.id == id).unwrap().parent.clone();
        assert_eq!(parent("b"), None, "없는 상위 폴더");
        assert!(parent("c").is_none() || parent("d").is_none(), "맴도는 폴더");
        assert_eq!(parent("e"), Some("a".into()));
        assert_eq!(library.placement.get("m1"), Some(&Some("a".into())));
        assert_eq!(library.placement.get("m2"), Some(&None));
        assert!(!library.placement.contains_key("deleted"));
        assert_eq!(library.titles.len(), 1);
        assert_eq!(library.title_of(&entry("m1")), "린");
        assert_eq!(library.title_of(&entry("m2")), "m2 이름");
    }
}
