//! 앱 안 업데이트. GitHub 최신 릴리스를 보고, 받는 파일이 맞으면 설치한 앱을 그 자리에서 바꾼 뒤 다시 켠다.
//!
//! macOS는 DMG 안의 .app을 지금 앱 자리에 넣고(앱이 꺼진 뒤), Windows는 NSIS 설치 파일을 조용히 실행한다.
//! 받는 주소는 GitHub HTTPS만 허용하고, 릴리스에 SHA-256이 있을 때만 설치한다.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

const LATEST: &str = "https://api.github.com/repos/sleeeppy/screenmate/releases/latest";
const RELEASE_BY_TAG: &str = "https://api.github.com/repos/sleeeppy/screenmate/releases/tags";
const RELEASES_PAGE: &str = "https://github.com/sleeeppy/screenmate/releases";
const BUNDLE_ID: &str = "dev.sleeeppy.screenmate";

static INSTALLING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    current: String,
    latest: Option<String>,
    /// 새 버전이 있고, 받은 파일로 지금 앱을 바꿀 수 있다
    available: bool,
    installable: bool,
    /// 설치할 수 없을 때 사용자에게 보여 줄 이유
    reason: Option<String>,
    page: Option<String>,
    /// 최신 릴리스의 패치노트 (내려받기 안내를 뺀 본문)
    notes: Option<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseNotes {
    version: String,
    body: String,
    page: String,
}

#[derive(Clone, serde::Serialize)]
struct UpdateProgress {
    phase: &'static str,
    fraction: f64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Download {
    name: String,
    url: String,
    sha256: Option<String>,
}

struct ReleaseInfo {
    version: String,
    page: String,
    notes: String,
    download: Option<Download>,
}

// ---------------------------------------------------------------- 버전·자산 고르기

/// `v0.2.0-rc1`처럼 출시 전 표기가 붙은 태그도 숫자 순서로 비교한다. 숫자가 같으면 출시 전 버전이 정식보다 낮다.
#[derive(Debug, PartialEq, Eq)]
struct ReleaseVersion {
    numbers: Vec<u64>,
    prerelease: Vec<String>,
}

impl ReleaseVersion {
    fn parse(text: &str) -> Option<Self> {
        let trimmed = text.trim().trim_start_matches(['v', 'V']);
        if trimmed.is_empty() {
            return None;
        }
        let (core, pre) = trimmed.split_once('-').unwrap_or((trimmed, ""));
        let numbers = core
            .split('.')
            .filter(|part| !part.is_empty())
            .map(|part| part.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().ok())
            .collect::<Option<Vec<u64>>>()?;
        if numbers.is_empty() || numbers.iter().all(|n| *n == 0) && core.chars().any(|c| !c.is_ascii_digit() && c != '.') {
            return None;
        }
        let prerelease = if pre.is_empty() {
            Vec::new()
        } else {
            pre.split('.').filter(|part| !part.is_empty()).map(str::to_string).collect()
        };
        Some(Self { numbers, prerelease })
    }
}

impl PartialOrd for ReleaseVersion {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for ReleaseVersion {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        let count = self.numbers.len().max(other.numbers.len());
        for index in 0..count {
            let left = self.numbers.get(index).copied().unwrap_or(0);
            let right = other.numbers.get(index).copied().unwrap_or(0);
            if left != right {
                return left.cmp(&right);
            }
        }
        match (self.prerelease.is_empty(), other.prerelease.is_empty()) {
            (true, false) => return std::cmp::Ordering::Greater,
            (false, true) => return std::cmp::Ordering::Less,
            (true, true) => return std::cmp::Ordering::Equal,
            (false, false) => {}
        }
        let identifiers = self.prerelease.len().max(other.prerelease.len());
        for index in 0..identifiers {
            match (self.prerelease.get(index), other.prerelease.get(index)) {
                (None, Some(_)) => return std::cmp::Ordering::Less,
                (Some(_), None) => return std::cmp::Ordering::Greater,
                (Some(left), Some(right)) => {
                    let order = match (left.parse::<u64>(), right.parse::<u64>()) {
                        (Ok(left), Ok(right)) => left.cmp(&right),
                        (Ok(_), Err(_)) => std::cmp::Ordering::Less,
                        (Err(_), Ok(_)) => std::cmp::Ordering::Greater,
                        (Err(_), Err(_)) => left.cmp(right),
                    };
                    if order != std::cmp::Ordering::Equal {
                        return order;
                    }
                }
                (None, None) => {}
            }
        }
        std::cmp::Ordering::Equal
    }
}

pub(crate) fn is_newer(remote: &str, local: &str) -> bool {
    match (ReleaseVersion::parse(remote), ReleaseVersion::parse(local)) {
        (Some(remote), Some(local)) => remote > local,
        _ => false,
    }
}

fn arch_tokens(arch: &str) -> &'static [&'static str] {
    match arch {
        "aarch64" | "arm64" => &["aarch64", "arm64"],
        "x86_64" | "x64" | "amd64" => &["x64", "x86_64", "amd64"],
        other => match other {
            _ => &[],
        },
    }
}

fn other_arch_tokens(arch: &str) -> &'static [&'static str] {
    match arch {
        "aarch64" | "arm64" => &["x64", "x86_64", "amd64"],
        _ => &["aarch64", "arm64"],
    }
}

fn mentions(name: &str, tokens: &[&str]) -> bool {
    let lower = name.to_ascii_lowercase();
    tokens.iter().any(|token| lower.contains(token))
}

/// 이 기기에 맞는 설치 파일. macOS는 DMG, Windows는 NSIS 설치 파일(`-setup.exe`).
fn choose_download(assets: &[Download], os: &str, arch: &str) -> Option<Download> {
    let wanted: Vec<&Download> = assets
        .iter()
        .filter(|asset| {
            let name = asset.name.to_ascii_lowercase();
            let kind = if os == "macos" {
                name.ends_with(".dmg")
            } else {
                name.ends_with(".exe") && name.contains("setup")
            };
            kind && !mentions(&name, other_arch_tokens(arch))
        })
        .collect();
    let tokens = arch_tokens(arch);
    wanted
        .iter()
        .copied()
        .find(|asset| mentions(&asset.name, tokens))
        .or_else(|| wanted.iter().copied().find(|asset| !mentions(&asset.name, tokens)))
        .cloned()
}

fn sha256_digest(value: Option<&str>) -> Option<String> {
    let lowered = value?.trim().to_ascii_lowercase();
    let hex = lowered.strip_prefix("sha256:")?;
    (hex.len() == 64 && hex.chars().all(|c| c.is_ascii_hexdigit())).then(|| hex.to_string())
}

fn allowed_download(url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(url) else {
        return false;
    };
    if url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str().map(|host| host.to_ascii_lowercase()) else {
        return false;
    };
    host == "github.com"
        || host.ends_with(".github.com")
        || host == "githubusercontent.com"
        || host.ends_with(".githubusercontent.com")
}

fn allowed_page(url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(url) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.path().starts_with("/sleeeppy/screenmate")
}

/// 릴리스 본문에서 "내려받기" 안내와 자동 생성된 Full Changelog 링크를 빼고 패치노트만 남긴다.
fn clean_release_notes(raw: &str) -> String {
    let mut out = Vec::new();
    let mut skip_download = false;
    for line in raw.lines() {
        let trimmed = line.trim();
        if let Some(heading) = trimmed.strip_prefix("## ") {
            skip_download = heading.trim().starts_with("내려받기");
            if skip_download {
                continue;
            }
        }
        if trimmed.starts_with("**Full Changelog**:") || trimmed.starts_with("Full Changelog:") {
            skip_download = false;
            continue;
        }
        if skip_download {
            continue;
        }
        out.push(line);
    }
    out.join("\n").trim().to_string()
}

fn parse_release(json: &str, os: &str, arch: &str) -> Result<ReleaseInfo, String> {
    let value: serde_json::Value = serde_json::from_str(json).map_err(|error| error.to_string())?;
    let version = value["tag_name"].as_str().unwrap_or("").trim().to_string();
    if version.is_empty() {
        return Err("릴리스 버전을 읽지 못했어요".into());
    }
    let page = value["html_url"].as_str().filter(|url| allowed_page(url)).unwrap_or(RELEASES_PAGE).to_string();
    let notes = clean_release_notes(value["body"].as_str().unwrap_or(""));
    let assets = value["assets"].as_array().cloned().unwrap_or_default();
    let downloads = assets
        .iter()
        .filter_map(|asset| {
            let name = asset["name"].as_str()?.to_string();
            let url = ["url", "browser_download_url"]
                .iter()
                .filter_map(|key| asset[*key].as_str())
                .find(|url| allowed_download(url))?
                .to_string();
            Some(Download { name, url, sha256: sha256_digest(asset["digest"].as_str()) })
        })
        .collect::<Vec<_>>();
    Ok(ReleaseInfo { version, page, notes, download: choose_download(&downloads, os, arch) })
}

// ---------------------------------------------------------------- 명령

fn current_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

fn status_of(current: &str, release: &ReleaseInfo) -> UpdateStatus {
    let newer = is_newer(&release.version, current);
    let (installable, reason) = match &release.download {
        Some(download) if newer && download.sha256.is_some() && can_replace() => (true, None),
        Some(download) if newer && download.sha256.is_none() => {
            (false, Some("체크섬이 없어 앱 안에서는 설치하지 않아요".into()))
        }
        Some(_) if newer => (false, Some("설치한 앱에서만 그 자리에서 바꿀 수 있어요".into())),
        _ => (false, None),
    };
    UpdateStatus {
        current: current.to_string(),
        latest: Some(release.version.clone()),
        available: newer,
        installable,
        reason,
        page: Some(release.page.clone()),
        notes: (!release.notes.is_empty()).then(|| release.notes.clone()),
    }
}

/// 네트워크를 기다리는 명령은 메인 스레드 밖에서 돌린다 (동기 명령은 메인 스레드라, 기다리는 동안 모든 창이 멈췄다)
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<UpdateStatus, String> {
    tauri::async_runtime::spawn_blocking(move || check(&app)).await.map_err(|error| error.to_string())?
}

fn check(app: &AppHandle) -> Result<UpdateStatus, String> {
    let current = current_version(app);
    let response = client()?
        .get(LATEST)
        .header("Accept", "application/vnd.github+json")
        .send()
        .map_err(|_| "업데이트를 확인하지 못했어요. 네트워크를 확인해 주세요".to_string())?;
    if response.status().as_u16() == 404 {
        return Ok(UpdateStatus {
            current,
            latest: None,
            available: false,
            installable: false,
            reason: None,
            page: None,
            notes: None,
        });
    }
    if !response.status().is_success() {
        return Err("업데이트를 확인하지 못했어요".into());
    }
    let json = response.text().map_err(|error| error.to_string())?;
    let release = parse_release(&json, std::env::consts::OS, std::env::consts::ARCH)?;
    Ok(status_of(&current, &release))
}

/// 지정한 버전(없으면 지금 앱 버전)의 GitHub 릴리스 패치노트를 가져온다.
#[tauri::command]
pub async fn fetch_release_notes(app: AppHandle, version: Option<String>) -> Result<ReleaseNotes, String> {
    tauri::async_runtime::spawn_blocking(move || load_release_notes(&app, version.as_deref()))
        .await
        .map_err(|error| error.to_string())?
}

fn load_release_notes(app: &AppHandle, version: Option<&str>) -> Result<ReleaseNotes, String> {
    let raw = version.map(str::trim).filter(|v| !v.is_empty()).map(str::to_string).unwrap_or_else(|| current_version(app));
    let clean_ver = raw.trim_start_matches(['v', 'V']);
    let tag = format!("v{clean_ver}");
    if !clean_ver.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')) {
        return Err("잘못된 버전 형식이에요".into());
    }
    let url = format!("{RELEASE_BY_TAG}/{tag}");
    let response = client()?
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .map_err(|_| "패치노트를 불러오지 못했어요. 네트워크를 확인해 주세요".to_string())?;
    if response.status().as_u16() == 404 {
        return Ok(ReleaseNotes {
            version: tag,
            body: String::new(),
            page: RELEASES_PAGE.to_string(),
        });
    }
    if !response.status().is_success() {
        return Err("패치노트를 불러오지 못했어요".into());
    }
    let json = response.text().map_err(|error| error.to_string())?;
    let release = parse_release(&json, std::env::consts::OS, std::env::consts::ARCH)?;
    Ok(ReleaseNotes {
        version: release.version,
        body: release.notes,
        page: release.page,
    })
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    if INSTALLING.swap(true, Ordering::Relaxed) {
        return Err("이미 설치하고 있어요".into());
    }
    let result = tauri::async_runtime::spawn_blocking(move || install(&app))
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result);
    if result.is_err() {
        INSTALLING.store(false, Ordering::Relaxed);
    }
    result
}

fn install(app: &AppHandle) -> Result<(), String> {
    let current = current_version(app);
    let response = client()?
        .get(LATEST)
        .header("Accept", "application/vnd.github+json")
        .send()
        .map_err(|_| "업데이트를 받지 못했어요".to_string())?;
    if !response.status().is_success() {
        return Err("업데이트를 받지 못했어요".into());
    }
    let release = parse_release(&response.text().map_err(|error| error.to_string())?, std::env::consts::OS, std::env::consts::ARCH)?;
    let status = status_of(&current, &release);
    if !status.installable {
        return Err(status.reason.unwrap_or_else(|| "설치할 업데이트가 없어요".into()));
    }
    let download = release.download.ok_or("설치 파일이 없어요")?;
    let sha = download.sha256.ok_or("체크섬이 없어요")?;
    if !allowed_download(&download.url) {
        return Err("받을 주소가 GitHub가 아니에요".into());
    }
    let work = std::env::temp_dir().join(format!("screenmate-update-{}", std::process::id()));
    fs::create_dir_all(&work).map_err(|error| error.to_string())?;
    let file = work.join(&download.name);
    let saved = download_file(app, &download.url, &file);
    if let Err(error) = saved {
        let _ = fs::remove_dir_all(&work);
        return Err(error);
    }
    let actual = match sha256_file(&file) {
        Ok(hash) => hash,
        Err(error) => {
            let _ = fs::remove_dir_all(&work);
            return Err(error);
        }
    };
    if actual != sha {
        let _ = fs::remove_dir_all(&work);
        return Err("받은 파일이 릴리스와 달라 설치하지 않았어요".into());
    }
    let _ = app.emit("update-progress", UpdateProgress { phase: "install", fraction: 1.0 });
    // 새 버전으로 다시 켜졌을 때 패치노트가 뜨도록 지금 버전을 기록해 둔다
    let _ = crate::settings::update(app, |settings| {
        if settings.seen_version.is_none() {
            settings.seen_version = Some(current.clone());
        }
    });
    let result = apply(app, &file, &work, release.version.trim_start_matches(['v', 'V']));
    if result.is_err() {
        let _ = fs::remove_dir_all(&work);
    }
    result
}

#[tauri::command]
pub fn open_update_page(page: String) -> Result<(), String> {
    if !allowed_page(&page) {
        return Err("열 수 없는 주소예요".into());
    }
    let opener = if cfg!(windows) { "explorer" } else if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    std::process::Command::new(opener).arg(page).spawn().map(|_| ()).map_err(|error| error.to_string())
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent("ScreenMate")
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let url = attempt.url();
            if url.scheme() == "https" && url.host_str().is_some_and(|host| {
                let host = host.to_ascii_lowercase();
                host == "github.com"
                    || host.ends_with(".github.com")
                    || host == "githubusercontent.com"
                    || host.ends_with(".githubusercontent.com")
            }) {
                attempt.follow()
            } else {
                attempt.error(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "redirect refused"))
            }
        }))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|error| error.to_string())
}

fn download_file(app: &AppHandle, url: &str, destination: &Path) -> Result<(), String> {
    let mut response = client()?
        .get(url)
        .header("Accept", "application/octet-stream")
        .send()
        .map_err(|_| "업데이트를 받지 못했어요".to_string())?;
    if !response.status().is_success() {
        return Err(format!("업데이트를 받지 못했어요 ({})", response.status()));
    }
    let total = response.content_length().unwrap_or(0);
    let mut file = fs::File::create(destination).map_err(|error| error.to_string())?;
    let mut buffer = [0u8; 64 * 1024];
    let mut got = 0u64;
    let mut reported = 255u8;
    loop {
        let read = response.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read]).map_err(|error| error.to_string())?;
        got += read as u64;
        if total > 0 {
            let percent = ((got * 100) / total).min(100) as u8;
            if percent != reported {
                reported = percent;
                let _ = app.emit("update-progress", UpdateProgress { phase: "download", fraction: f64::from(percent) / 100.0 });
            }
        }
    }
    if got == 0 {
        return Err("받은 파일이 비어 있어요".into());
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    Ok(Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect())
}

/// 디렉토리에 현재 프로세스가 실제로 파일을 쓰고 지울 수 있는지 확인한다.
/// Unix의 `permissions().readonly()`는 모든 쓰기 비트가 0일 때만 true라 `/Applications` (0775 root:admin)에서
/// 표준 계정의 쓰기 불가 상태를 걸러내지 못한다.
#[cfg(any(target_os = "macos", test))]
fn can_write_dir(dir: &Path) -> bool {
    let probe = dir.join(format!(".screenmate-write-probe-{}", std::process::id()));
    let created = fs::OpenOptions::new().write(true).create_new(true).open(&probe).is_ok();
    if created {
        let _ = fs::remove_file(&probe);
    }
    created
}

/// 설치한 앱만 그 자리에서 바꾼다. 개발 빌드(`target/`)나 DMG 안에서 켠 앱은 아니다.
fn can_replace() -> bool {
    #[cfg(target_os = "macos")]
    {
        installed_app().is_some_and(|app| {
            let path = app.to_string_lossy();
            !path.starts_with("/Volumes/")
                && !path.contains("/AppTranslocation/")
                && app.parent().is_some_and(can_write_dir)
        })
    }
    #[cfg(target_os = "windows")]
    {
        std::env::current_exe().ok().is_some_and(|exe| {
            let path = exe.to_string_lossy().to_ascii_lowercase();
            !path.contains("\\target\\") && !path.contains("/target/")
        })
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        false
    }
}

fn apply(app: &AppHandle, file: &Path, work: &Path, version: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        apply_macos(app, file, work, version)
    }
    #[cfg(target_os = "windows")]
    {
        let _ = version;
        apply_windows(app, file, work)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (app, file, work, version);
        Err("이 운영체제에서는 앱 안 설치를 지원하지 않아요".into())
    }
}

#[cfg(target_os = "macos")]
fn installed_app() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let app = contents.parent()?;
    (macos.file_name() == Some("MacOS".as_ref())
        && contents.file_name() == Some("Contents".as_ref())
        && app.extension() == Some("app".as_ref()))
    .then(|| app.to_path_buf())
}

#[cfg(target_os = "macos")]
fn apply_macos(app: &AppHandle, dmg: &Path, work: &Path, version: &str) -> Result<(), String> {
    let target = installed_app().ok_or("설치한 앱이 아니라 그 자리에서 바꿀 수 없어요")?;
    let staged = extract_app(dmg, work)?;
    verify_bundle(&staged, version)?;
    verify_signature(&target, &staged)?;
    let _ = std::process::Command::new("xattr").args(["-dr", "com.apple.quarantine"]).arg(&staged).status();
    launch_swap(&staged, &target, work)?;
    app.exit(0);
    Ok(())
}

#[cfg(target_os = "macos")]
fn extract_app(dmg: &Path, work: &Path) -> Result<PathBuf, String> {
    let mount = work.join("mount");
    fs::create_dir_all(&mount).map_err(|error| error.to_string())?;
    run("/usr/bin/hdiutil", &["attach", dmg.to_str().unwrap_or(""), "-nobrowse", "-readonly", "-noautoopen", "-noverify", "-mountpoint", mount.to_str().unwrap_or("")])?;
    let found = fs::read_dir(&mount).map_err(|error| error.to_string()).and_then(|entries| {
        let apps = entries
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| path.extension() == Some("app".as_ref()))
            .collect::<Vec<_>>();
        apps.into_iter()
            .find(|path| path.file_name() == Some("ScreenMate.app".as_ref()))
            .ok_or_else(|| "디스크 이미지 안에 앱이 없어요".to_string())
    });
    let staged = work.join("ScreenMate.app");
    let copied = found.and_then(|source| run("/usr/bin/ditto", &[source.to_str().unwrap_or(""), staged.to_str().unwrap_or("")]));
    let detached = run("/usr/bin/hdiutil", &["detach", mount.to_str().unwrap_or(""), "-force"]);
    copied?;
    detached?;
    Ok(staged)
}

#[cfg(target_os = "macos")]
fn verify_bundle(app: &Path, version: &str) -> Result<(), String> {
    let plist = app.join("Contents/Info.plist");
    let id = plist_value(&plist, "CFBundleIdentifier")?;
    let found = plist_value(&plist, "CFBundleShortVersionString")?;
    if id != BUNDLE_ID {
        return Err("받은 앱이 ScreenMate가 아니에요".into());
    }
    if found != version {
        return Err(format!("받은 앱 버전({found})이 릴리스({version})와 달라요"));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn plist_value(plist: &Path, key: &str) -> Result<String, String> {
    let output = std::process::Command::new("/usr/bin/plutil")
        .args(["-extract", key, "raw", "-o", "-"])
        .arg(plist)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("앱 정보를 읽지 못했어요".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// 지금 앱이 개발자 서명으로 고정돼 있으면 새 앱도 그 서명이어야 한다 (권한 유지). 임시 서명은 빌드마다 달라 통과시킨다.
#[cfg(target_os = "macos")]
fn verify_signature(current: &Path, candidate: &Path) -> Result<(), String> {
    run("/usr/bin/codesign", &["--verify", "--strict", "--deep", candidate.to_str().unwrap_or("")])
        .map_err(|_| "새 앱 서명이 올바르지 않아요".to_string())?;
    let Some(requirement) = designated_requirement(current) else {
        return Ok(());
    };
    if requirement.contains("cdhash") {
        return Ok(());
    }
    let status = std::process::Command::new("/usr/bin/codesign")
        .args(["--verify", "--strict", "--deep", "-R", &requirement])
        .arg(candidate)
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("새 앱의 서명이 지금 앱과 달라 권한을 이어받을 수 없어요".into())
    }
}

#[cfg(target_os = "macos")]
fn designated_requirement(app: &Path) -> Option<String> {
    let output = std::process::Command::new("/usr/bin/codesign").args(["-d", "-r", "-"]).arg(app).output().ok()?;
    let text = String::from_utf8_lossy(&output.stderr);
    text.lines().find_map(|line| line.split_once("=>").map(|(_, requirement)| requirement.trim().to_string()))
}

#[cfg(target_os = "macos")]
fn launch_swap(staged: &Path, target: &Path, work: &Path) -> Result<(), String> {
    let script = work.join("swap.sh");
    fs::write(&script, SWAP_SCRIPT).map_err(|error| error.to_string())?;
    let mut permissions = fs::metadata(&script).map_err(|error| error.to_string())?.permissions();
    use std::os::unix::fs::PermissionsExt;
    permissions.set_mode(0o755);
    fs::set_permissions(&script, permissions).map_err(|error| error.to_string())?;
    std::process::Command::new("/bin/sh")
        .arg(&script)
        .arg(std::process::id().to_string())
        .arg(staged)
        .arg(target)
        .arg(work)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
const SWAP_SCRIPT: &str = r#"#!/bin/sh
pid="$1"; staged="$2"; target="$3"; work="$4"
tries=0
while kill -0 "$pid" 2>/dev/null; do
  tries=$((tries + 1))
  [ "$tries" -gt 150 ] && exit 1
  sleep 0.2
done
parent="$(dirname "$target")"
backup="$parent/.ScreenMate.prev.$$"
if mv "$target" "$backup"; then
  if mv "$staged" "$target" 2>/dev/null || /usr/bin/ditto "$staged" "$target"; then
    rm -rf "$backup" "$work"
  else
    rm -rf "$target"
    mv "$backup" "$target"
    rm -rf "$work"
  fi
else
  rm -rf "$work"
fi
open "$target"
"#;

#[cfg(target_os = "macos")]
fn run(program: &str, args: &[&str]) -> Result<(), String> {
    let status = std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() { Ok(()) } else { Err(format!("{program} 실패")) }
}

/// 이 프로세스가 끝난 뒤에 설치 파일을 조용히 실행하고, 같은 자리의 실행 파일을 다시 연 뒤 임시 폴더를 지운다.
#[cfg(target_os = "windows")]
fn apply_windows(app: &AppHandle, installer: &Path, work: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    let current = std::env::current_exe().map_err(|error| error.to_string())?;
    let quote = |path: &Path| path.display().to_string().replace('\'', "''");
    let script = installer.with_extension("ps1");
    fs::write(
        &script,
        format!(
            "Wait-Process -Id {pid} -ErrorAction SilentlyContinue\n\
             Start-Process -FilePath '{installer}' -ArgumentList '/S' -Wait\n\
             Start-Process -FilePath '{current}'\n\
             Remove-Item -LiteralPath '{work}' -Recurse -Force -ErrorAction SilentlyContinue\n",
            pid = std::process::id(),
            installer = quote(installer),
            current = quote(&current),
            work = quote(work),
        ),
    )
    .map_err(|error| error.to_string())?;
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .map_err(|error| error.to_string())?;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_versions_with_prerelease() {
        assert!(is_newer("v0.2.0", "0.1.0"));
        assert!(is_newer("0.1.1", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.2.0"));
        assert!(is_newer("0.2.0", "0.2.0-rc1"));
        assert!(is_newer("0.2.0-rc2", "0.2.0-rc1"));
        assert!(!is_newer("0.2.0-rc1", "0.2.0"));
        assert!(!is_newer("not-a-version", "0.1.0"));
    }

    fn asset(name: &str, digest: bool) -> Download {
        Download {
            name: name.into(),
            url: format!("https://api.github.com/repos/sleeeppy/screenmate/releases/assets/{name}"),
            sha256: digest.then(|| "ab".repeat(32)),
        }
    }

    #[test]
    fn picks_the_file_for_this_machine() {
        let assets = vec![
            asset("ScreenMate_0.2.0_x64-setup.exe", true),
            asset("ScreenMate_0.2.0_aarch64.dmg", true),
            asset("ScreenMate_0.2.0_x64.dmg", true),
            asset("ScreenMate_0.2.0_aarch64-setup.exe", true),
            asset("notes.txt", true),
        ];
        assert_eq!(choose_download(&assets, "macos", "aarch64").unwrap().name, "ScreenMate_0.2.0_aarch64.dmg");
        assert_eq!(choose_download(&assets, "macos", "x86_64").unwrap().name, "ScreenMate_0.2.0_x64.dmg");
        assert_eq!(choose_download(&assets, "windows", "x86_64").unwrap().name, "ScreenMate_0.2.0_x64-setup.exe");
        assert_eq!(choose_download(&assets, "windows", "aarch64").unwrap().name, "ScreenMate_0.2.0_aarch64-setup.exe");
    }

    #[test]
    fn accepts_one_dmg_without_an_arch_name() {
        let assets = vec![asset("ScreenMate.dmg", true)];
        assert_eq!(choose_download(&assets, "macos", "aarch64").unwrap().name, "ScreenMate.dmg");
    }

    #[test]
    fn reads_a_release_and_only_offers_a_newer_checksummed_build() {
        let json = r#"{
            "tag_name": "v0.2.0",
            "html_url": "https://github.com/sleeeppy/screenmate/releases/tag/v0.2.0",
            "assets": [
                {"name": "ScreenMate_0.2.0_aarch64.dmg", "url": "https://api.github.com/repos/sleeeppy/screenmate/releases/assets/1", "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
                {"name": "ScreenMate_0.2.0_x64-setup.exe", "browser_download_url": "https://github.com/sleeeppy/screenmate/releases/download/v0.2.0/setup.exe"}
            ]
        }"#;
        let release = parse_release(json, "macos", "aarch64").unwrap();
        assert_eq!(release.version, "v0.2.0");
        assert!(release.download.unwrap().sha256.is_some());
        let status = status_of("0.1.0", &parse_release(json, "macos", "aarch64").unwrap());
        assert!(status.available);
        let same = status_of("0.2.0", &parse_release(json, "macos", "aarch64").unwrap());
        assert!(!same.available);
        assert!(!same.installable);
    }

    #[test]
    fn refuses_downloads_outside_github() {
        assert!(allowed_download("https://github.com/sleeeppy/screenmate/releases/download/v0.2.0/a.dmg"));
        assert!(allowed_download("https://release-assets.githubusercontent.com/file"));
        assert!(!allowed_download("http://github.com/a.dmg"));
        assert!(!allowed_download("https://example.com/a.dmg"));
        assert!(allowed_page("https://github.com/sleeeppy/screenmate/releases/tag/v0.2.0"));
        assert!(!allowed_page("https://github.com/other/screenmate/releases"));
    }

    #[test]
    fn falls_back_to_valid_releases_page_when_html_url_missing() {
        let json = r#"{"tag_name": "v0.2.0", "assets": []}"#;
        let release = parse_release(json, "macos", "aarch64").unwrap();
        assert!(allowed_page(&release.page), "fallback page={} must pass allowed_page", release.page);
    }

    #[test]
    fn can_write_dir_checks_actual_writability() {
        let dir = std::env::temp_dir();
        assert!(can_write_dir(&dir));
        assert!(!can_write_dir(Path::new("/nonexistent-screenmate-dir")));
    }

    #[test]
    fn strips_download_section_and_full_changelog_from_release_notes() {
        let raw = "\
## 바뀐 내용

- 버그 수정
- 패치노트 추가

## 내려받기

- **macOS**: [dmg](https://example.com)

설치 파일에는 모델이 들어 있지 않아요.

**Full Changelog**: https://github.com/sleeeppy/screenmate/compare/v0.1.2...v0.1.3";
        assert_eq!(clean_release_notes(raw), "## 바뀐 내용\n\n- 버그 수정\n- 패치노트 추가");
    }
}
