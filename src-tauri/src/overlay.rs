//! 투명 오버레이 창: 창 스타일, 클릭 통과, 커서 폴링, 모니터 옮기기.
//!
//! 성능 메모
//! - 창 위치·크기·배율은 창 이벤트가 올 때만 갱신해서 캐시한다. 폴링 스레드에서
//!   `outer_position()` 등을 부르면 매번 메인 스레드와 동기 왕복이 생긴다.
//! - 커서 이벤트는 웹뷰가 알려준 관심 영역(캐릭터 주변) 안에서, 위치가 바뀔 때만 보낸다.
//!   관심 영역을 드나들 때는 한 번씩 보내서 웹뷰가 "가까움/멂"을 알 수 있게 한다.

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WindowEvent};

use crate::monitors::{self, Screen};
use crate::settings::SettingsState;

/// 커서가 캐릭터 근처에 있을 때 (눈·고개가 커서를 매끄럽게 따라가야 함)
const POLL_NEAR: Duration = Duration::from_millis(8);
/// 멀리 있을 때는 근처로 들어오는지만 보면 된다
const POLL_FAR: Duration = Duration::from_millis(33);
/// 전체화면이라 캐릭터가 숨어 있을 때
const POLL_HIDDEN: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Default)]
struct Geometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale: f64,
}

/// 웹뷰 좌표(CSS px, 창 왼쪽 위 기준) 사각형
#[derive(Clone, Copy, Debug, serde::Deserialize, serde::Serialize)]
pub struct CssRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl CssRect {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
    }
}

#[derive(Default)]
pub struct OverlayState {
    geometry: Mutex<Geometry>,
    interest: Mutex<Option<CssRect>>,
    /// 오버레이를 띄운 모니터 전체 (작업 영역 아님). 물리 px 왼쪽 위·크기와 배율.
    /// 웹뷰가 거의 동시에 여러 번 옮겨 달라고 해도 한 번에 하나씩 처리하도록 이 잠금 안에서 옮긴다.
    monitor: Mutex<Option<(i32, i32, u32, u32, f64)>>,
}

impl OverlayState {
    /// 오버레이 창 왼쪽 위(물리 px)와 배율
    pub fn origin(&self) -> (i32, i32, f64) {
        let geometry = *self.geometry.lock().unwrap();
        (geometry.x, geometry.y, geometry.scale)
    }

    /// 오버레이를 띄운 모니터 전체 (물리 px 왼쪽 위·크기, 배율)
    pub fn monitor(&self) -> Option<(i32, i32, u32, u32, f64)> {
        *self.monitor.lock().unwrap()
    }
}

#[derive(Clone, serde::Serialize)]
struct CursorPayload {
    x: f64,
    y: f64,
    near: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageInfo {
    width: f64,
    height: f64,
    scale: f64,
    work_area: CssRect,
    /// 왼쪽·오른쪽에 맞닿은 모니터가 있다 (던지면 그쪽 모니터로 넘어간다)
    open_left: bool,
    open_right: bool,
}

/// 다른 모니터로 옮긴 결과: 새 무대 정보와, 요청한 점을 새 창 기준으로 바꾼 좌표
#[derive(serde::Serialize)]
pub struct Transfer {
    info: StageInfo,
    x: f64,
    y: f64,
}

pub fn install(app: &AppHandle, window: &WebviewWindow) -> tauri::Result<()> {
    let state = Arc::new(OverlayState::default());
    app.manage(state.clone());

    // 마지막에 있던 모니터에서 시작한다 (없으면 주 모니터)
    let screens = monitors::screens(app);
    let wanted = app.state::<SettingsState>().0.lock().unwrap().monitor.clone();
    if let Some(screen) = monitors::remembered(&screens, wanted.as_ref()).map(|index| &screens[index]) {
        monitors::fit_window(window, screen)?;
        *state.monitor.lock().unwrap() = Some(monitors::screen_key(screen));
    }
    window.set_ignore_cursor_events(true)?;
    reapply_window_chrome(window);
    refresh_geometry(window, &state);

    let event_window = window.clone();
    let event_state = state.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }
        ) {
            refresh_geometry(&event_window, &event_state);
        }
    });

    let poll_app = app.clone();
    thread::Builder::new()
        .name("cursor-poll".into())
        .spawn(move || poll_cursor(poll_app, state))
        .expect("cursor poll thread");

    Ok(())
}

fn refresh_geometry(window: &WebviewWindow, state: &OverlayState) {
    let (Ok(position), Ok(size), Ok(scale)) =
        (window.outer_position(), window.outer_size(), window.scale_factor())
    else {
        return;
    };
    *state.geometry.lock().unwrap() = Geometry {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        scale,
    };
}

/// 오버레이 기준 CSS px 한 점 → 데스크톱 좌표 (Windows 물리 px, macOS 포인트)
fn css_to_desktop(geometry: &Geometry, x: f64, y: f64) -> (f64, f64) {
    if cfg!(target_os = "macos") {
        (geometry.x as f64 / geometry.scale + x, geometry.y as f64 / geometry.scale + y)
    } else {
        (geometry.x as f64 + x * geometry.scale, geometry.y as f64 + y * geometry.scale)
    }
}

fn desktop_to_css(geometry: &Geometry, x: f64, y: f64) -> (f64, f64) {
    if cfg!(target_os = "macos") {
        (x - geometry.x as f64 / geometry.scale, y - geometry.y as f64 / geometry.scale)
    } else {
        ((x - geometry.x as f64) / geometry.scale, (y - geometry.y as f64) / geometry.scale)
    }
}

/// 오버레이를 다른 모니터로 옮긴다. 상태(모니터·창 위치)를 갱신하고 설정에 기억한다.
fn move_to(app: &AppHandle, window: &WebviewWindow, state: &OverlayState, screen: &Screen) -> tauri::Result<()> {
    monitors::fit_window(window, screen)?;
    *state.monitor.lock().unwrap() = Some(monitors::screen_key(screen));
    refresh_geometry(window, state);
    if cfg!(not(target_os = "macos")) {
        // Windows: DPI 변경 처리 전에 읽은 배율일 수 있어 옮긴 모니터의 배율로 맞춘다
        state.geometry.lock().unwrap().scale = screen.scale;
    }
    let remembered = monitors::reference(screen);
    let _ = crate::settings::update(app, |settings| settings.monitor = Some(remembered));
    Ok(())
}

/// 캐릭터를 끌거나 던져서 창 밖(CSS px, 지금 오버레이 기준) 한 점에 닿았을 때.
/// 그 점이 다른 모니터 위면 오버레이를 그 모니터로 옮기고, 같은 점의 새 좌표를 돌려준다. 아니면 None.
#[tauri::command]
pub fn transfer_monitor(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, Arc<OverlayState>>,
    x: f64,
    y: f64,
) -> Result<Option<Transfer>, String> {
    let geometry = *state.geometry.lock().unwrap();
    if geometry.scale <= 0.0 {
        return Ok(None);
    }
    let (desktop_x, desktop_y) = css_to_desktop(&geometry, x, y);
    let screens = monitors::screens(&app);
    let Some(target) = monitors::find_at(&screens, desktop_x, desktop_y).map(|index| &screens[index]) else {
        return Ok(None);
    };
    let current = state.monitor();
    if current.is_some_and(|key| monitors::same_screen(target, key)) {
        return Ok(None);
    }
    move_to(&app, &window, &state, target).map_err(|error| error.to_string())?;
    let moved = *state.geometry.lock().unwrap();
    let (x, y) = desktop_to_css(&moved, desktop_x, desktop_y);
    let info = stage_info(app, window, state)?;
    Ok(Some(Transfer { info, x, y }))
}

/// 모니터를 빼거나 해상도·배치가 바뀌어 지금 모니터가 그대로 없으면 기억한 모니터(없으면 주 모니터)로 다시 맞춘다.
/// 창 목록 폴링 스레드에서 가끔 부른다. 웹뷰는 창 크기 변경(resize)으로 새 무대 정보를 받는다.
pub fn check_monitor(app: &AppHandle) {
    let state = app.state::<Arc<OverlayState>>();
    let Some(current) = state.monitor() else {
        return;
    };
    let screens = monitors::screens(app);
    if screens.is_empty() || screens.iter().any(|screen| monitors::same_screen(screen, current)) {
        return;
    }
    let wanted = app.state::<SettingsState>().0.lock().unwrap().monitor.clone();
    let Some(index) = monitors::remembered(&screens, wanted.as_ref()) else {
        return;
    };
    let screen = screens[index].clone();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window("main") else {
            return;
        };
        let state = handle.state::<Arc<OverlayState>>();
        // 주 모니터로 돌아갈 때는 기억한 모니터를 지우지 않는다 (다시 꽂으면 그쪽에서 시작하게 fit_window만)
        let _ = monitors::fit_window(&window, &screen);
        *state.monitor.lock().unwrap() = Some(monitors::screen_key(&screen));
        refresh_geometry(&window, &state);
    });
}

/// Alt+Tab·작업표시줄에서 숨기고, 클릭해도 포커스를 뺏지 않으며, DWM 테두리를 없앤다.
#[cfg(windows)]
fn hide_window_chrome(window: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let hwnd = HWND(hwnd.0);
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let extra = (WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0 | WS_EX_LAYERED.0) as isize;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | extra);

        let color = DWMWA_COLOR_NONE;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR,
            &color as *const u32 as *const _,
            std::mem::size_of::<u32>() as u32,
        );
    }
}

/// macOS 등: 모든 데스크톱(Space)에 보이게 한다. 나머지는 tauri.conf.json 창 설정으로 충분하다.
#[cfg(not(windows))]
fn hide_window_chrome(window: &WebviewWindow) {
    let _ = window.set_visible_on_all_workspaces(true);
}

/// 화면 물리 px 커서 위치
#[cfg(windows)]
fn cursor_point(_app: &AppHandle, _scale: f64) -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut point = POINT::default();
    unsafe { GetCursorPos(&mut point) }.ok()?;
    Some((point.x, point.y))
}

/// macOS: tauri의 cursor_position()은 매번 메인 스레드를 거쳐 와서(초당 125번) 그것만으로 CPU 한 코어의 약 4.5%를 썼다.
/// CoreGraphics에서 바로 읽는다 (포인트 단위 → 오버레이 배율을 곱해 물리 px).
#[cfg(target_os = "macos")]
fn cursor_point(_app: &AppHandle, scale: f64) -> Option<(i32, i32)> {
    use core_graphics::event::CGEvent;
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState).ok()?;
    let point = CGEvent::new(source).ok()?.location();
    Some(((point.x * scale).round() as i32, (point.y * scale).round() as i32))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn cursor_point(app: &AppHandle, _scale: f64) -> Option<(i32, i32)> {
    let position = app.cursor_position().ok()?;
    Some((position.x.round() as i32, position.y.round() as i32))
}

fn poll_cursor(app: AppHandle, state: Arc<OverlayState>) {
    let mut last_point: Option<(i32, i32)> = None;
    let mut was_near = false;
    loop {
        thread::sleep(if was_near { POLL_NEAR } else { POLL_FAR });
        if crate::platforms::is_fullscreen(&app) {
            if was_near {
                let _ = app.emit_to("main", "cursor", CursorPayload { x: -1.0, y: -1.0, near: false });
                was_near = false;
            }
            thread::sleep(POLL_HIDDEN);
            continue;
        }

        let geometry = *state.geometry.lock().unwrap();
        if geometry.scale <= 0.0 {
            continue;
        }
        let Some((point_x, point_y)) = cursor_point(&app, geometry.scale) else {
            continue;
        };
        let x = (point_x - geometry.x) as f64 / geometry.scale;
        let y = (point_y - geometry.y) as f64 / geometry.scale;
        let inside_window = point_x >= geometry.x
            && point_y >= geometry.y
            && point_x < geometry.x + geometry.width as i32
            && point_y < geometry.y + geometry.height as i32;
        let near = inside_window
            && state
                .interest
                .lock()
                .unwrap()
                .is_some_and(|rect| rect.contains(x, y));

        let moved = last_point != Some((point_x, point_y));
        if (near && moved) || near != was_near {
            if app.emit_to("main", "cursor", CursorPayload { x, y, near }).is_err() {
                break;
            }
        }
        last_point = Some((point_x, point_y));
        was_near = near;
    }
}

/// 클릭 통과 켜기/끄기.
///
/// tao는 이 전환 때마다 확장 스타일을 처음부터 다시 계산해서 우리가 붙인 스타일
/// (Alt+Tab 숨김, 테두리 없음)을 지운다. 그래서 전환 직후 같은 메인 스레드 큐에서 다시 붙인다.
/// 포커스를 뺏지 않는 WS_EX_NOACTIVATE는 tauri.conf.json의 `focusable: false`로 tao가 유지한다.
#[tauri::command]
pub fn set_click_through(window: WebviewWindow, ignore: bool) -> Result<(), String> {
    window.set_ignore_cursor_events(ignore).map_err(|error| error.to_string())?;
    reapply_window_chrome(&window);
    Ok(())
}

/// 메인 스레드에서 창 스타일을 다시 붙인다 (tao의 스타일 갱신 뒤에 실행되도록 같은 큐에 넣음).
fn reapply_window_chrome(window: &WebviewWindow) {
    let target = window.clone();
    let _ = window.run_on_main_thread(move || hide_window_chrome(&target));
}

/// 캐릭터 주변 관심 영역. 이 영역 안에서만 커서 위치를 받는다.
#[tauri::command]
pub fn set_interest_rect(state: tauri::State<'_, Arc<OverlayState>>, rect: Option<CssRect>) {
    *state.interest.lock().unwrap() = rect;
}

/// 마우스 버튼(왼쪽·오른쪽·가운데)이 눌려 있는지. 클릭 통과 중이라 웹뷰가 받지 못한 클릭을 알아챌 때 쓴다.
/// 이 플랫폼에서 알 수 없으면 None.
#[tauri::command]
pub fn mouse_pressed() -> Option<bool> {
    mouse_buttons_down()
}

#[cfg(windows)]
fn mouse_buttons_down() -> Option<bool> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON};
    Some(
        [VK_LBUTTON, VK_RBUTTON, VK_MBUTTON]
            .iter()
            .any(|key| unsafe { GetAsyncKeyState(i32::from(key.0)) } < 0),
    )
}

#[cfg(target_os = "macos")]
fn mouse_buttons_down() -> Option<bool> {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceButtonState(state_id: i32, button: u32) -> bool;
    }
    // kCGEventSourceStateCombinedSessionState = 0, 버튼 0 왼쪽 · 1 오른쪽 · 2 가운데
    Some((0..3).any(|button| unsafe { CGEventSourceButtonState(0, button) }))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn mouse_buttons_down() -> Option<bool> {
    None
}

/// 창 크기와 작업 영역(작업표시줄 제외)을 CSS px로 돌려준다.
#[tauri::command]
pub fn stage_info(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, Arc<OverlayState>>,
) -> Result<StageInfo, String> {
    let (open_left, open_right) = state
        .monitor()
        .and_then(|key| {
            let screens = monitors::screens(&app);
            let current = screens.iter().find(|screen| monitors::same_screen(screen, key))?.rect;
            Some(monitors::open_sides(&screens, &current))
        })
        .unwrap_or((false, false));
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .ok_or("no monitor")?;
    let area = monitor.work_area();
    Ok(StageInfo {
        width: size.width as f64 / scale,
        height: size.height as f64 / scale,
        scale,
        work_area: CssRect {
            x: (area.position.x - position.x) as f64 / scale,
            y: (area.position.y - position.y) as f64 / scale,
            width: area.size.width as f64 / scale,
            height: area.size.height as f64 / scale,
        },
        open_left,
        open_right,
    })
}
