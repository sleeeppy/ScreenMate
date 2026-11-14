//! 다중 모니터.
//!
//! 오버레이 창은 캐릭터가 있는 모니터 하나만 덮는다. 창 하나로 모든 모니터를 덮으면 모니터마다 배율이 다를 때
//! 웹뷰가 한 배율로만 그리고, macOS는 창 하나가 여러 디스플레이에 걸쳐 보이지 않는다.
//! 캐릭터를 끌어서 다른 모니터로 가져가거나 옆 모니터 쪽으로 던지면 오버레이를 그 모니터로 옮긴다.
//!
//! 모니터 비교는 "데스크톱 좌표"로 한다. Windows는 물리 px(모든 모니터가 한 좌표계), macOS는 포인트다.
//! (macOS에서 tauri가 주는 물리 px는 모니터마다 자기 배율을 곱한 값이라 모니터끼리 이어지지 않는다.)

use tauri::{AppHandle, LogicalPosition, LogicalSize, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

/// 모니터 경계가 맞닿았다고 볼 여유 (데스크톱 좌표)
const TOUCH_SLACK: f64 = 2.0;

/// 데스크톱 좌표 사각형
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

impl Rect {
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.left && y >= self.top && x < self.right && y < self.bottom
    }
}

/// 모니터 하나: 데스크톱 좌표 사각형과 tauri가 주는 원래 값
#[derive(Clone, Debug)]
pub struct Screen {
    pub name: Option<String>,
    pub rect: Rect,
    /// 물리 px 왼쪽 위·크기
    pub physical: (i32, i32, u32, u32),
    pub scale: f64,
    pub primary: bool,
}

/// 기억해 둔 모니터 (설정 파일). 이름이 같은 모니터가 여럿이면 위치로 고른다.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MonitorRef {
    pub name: Option<String>,
    pub x: i32,
    pub y: i32,
}

fn desktop_rect(x: i32, y: i32, width: u32, height: u32, scale: f64) -> Rect {
    if cfg!(target_os = "macos") {
        let points = scale.max(0.1);
        Rect {
            left: x as f64 / points,
            top: y as f64 / points,
            right: (x as f64 + width as f64) / points,
            bottom: (y as f64 + height as f64) / points,
        }
    } else {
        Rect { left: x as f64, top: y as f64, right: x as f64 + width as f64, bottom: y as f64 + height as f64 }
    }
}

fn screen_of(monitor: &Monitor, primary: Option<&Monitor>) -> Screen {
    let position = monitor.position();
    let size = monitor.size();
    let scale = monitor.scale_factor();
    let is_primary = primary.is_some_and(|primary| primary.position() == position && primary.size() == size);
    Screen {
        name: monitor.name().cloned(),
        rect: desktop_rect(position.x, position.y, size.width, size.height, scale),
        physical: (position.x, position.y, size.width, size.height),
        scale,
        primary: is_primary,
    }
}

/// 연결된 모니터 전부
pub fn screens(app: &AppHandle) -> Vec<Screen> {
    let primary = app.primary_monitor().ok().flatten();
    app.available_monitors()
        .map(|monitors| monitors.iter().map(|monitor| screen_of(monitor, primary.as_ref())).collect())
        .unwrap_or_default()
}

/// 오버레이 상태에 저장한 값 (물리 px 왼쪽 위·크기, 배율)
pub fn screen_key(screen: &Screen) -> (i32, i32, u32, u32, f64) {
    let (x, y, width, height) = screen.physical;
    (x, y, width, height, screen.scale)
}

pub fn same_screen(screen: &Screen, key: (i32, i32, u32, u32, f64)) -> bool {
    let (x, y, width, height, scale) = key;
    screen.physical == (x, y, width, height) && (screen.scale - scale).abs() < 0.001
}

/// 데스크톱 좌표 한 점이 들어 있는 모니터
pub fn find_at(screens: &[Screen], x: f64, y: f64) -> Option<usize> {
    screens.iter().position(|screen| screen.rect.contains(x, y))
}

/// 기억해 둔 모니터 → 이름과 위치가 같은 것, 없으면 이름만 같은 것, 없으면 주 모니터
pub fn remembered(screens: &[Screen], wanted: Option<&MonitorRef>) -> Option<usize> {
    if let Some(wanted) = wanted {
        let exact = screens
            .iter()
            .position(|screen| screen.name == wanted.name && (screen.physical.0, screen.physical.1) == (wanted.x, wanted.y));
        let named = || screens.iter().position(|screen| wanted.name.is_some() && screen.name == wanted.name);
        if let Some(index) = exact.or_else(named) {
            return Some(index);
        }
    }
    screens.iter().position(|screen| screen.primary).or(if screens.is_empty() { None } else { Some(0) })
}

pub fn reference(screen: &Screen) -> MonitorRef {
    MonitorRef { name: screen.name.clone(), x: screen.physical.0, y: screen.physical.1 }
}

/// 왼쪽·오른쪽에 맞닿은 모니터가 있는지 (세로로 조금이라도 겹쳐야 한다). 던지면 그쪽으로 넘어갈 수 있다.
pub fn open_sides(screens: &[Screen], current: &Rect) -> (bool, bool) {
    let overlaps = |other: &Rect| other.top < current.bottom && other.bottom > current.top;
    let left = screens
        .iter()
        .any(|screen| overlaps(&screen.rect) && (screen.rect.right - current.left).abs() <= TOUCH_SLACK);
    let right = screens
        .iter()
        .any(|screen| overlaps(&screen.rect) && (screen.rect.left - current.right).abs() <= TOUCH_SLACK);
    (left, right)
}

/// 오버레이 창을 모니터 하나에 딱 맞게 놓는다.
pub fn fit_window(window: &WebviewWindow, screen: &Screen) -> tauri::Result<()> {
    if cfg!(target_os = "macos") {
        // macOS: 물리 px로 주면 창의 "지금" 배율로 나눠 포인트로 바꾸므로, 배율이 다른 모니터로 옮길 때 어긋난다
        let rect = screen.rect;
        window.set_position(LogicalPosition::new(rect.left, rect.top))?;
        window.set_size(LogicalSize::new(rect.right - rect.left, rect.bottom - rect.top))?;
    } else {
        // Windows: 배율이 다른 모니터로 옮기면 그 순간 DPI 변경으로 크기가 다시 계산된다. 옮긴 뒤 크기를 다시 정한다.
        let (x, y, width, height) = screen.physical;
        window.set_position(PhysicalPosition::new(x, y))?;
        window.set_size(PhysicalSize::new(width, height))?;
        window.set_position(PhysicalPosition::new(x, y))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen(left: f64, top: f64, right: f64, bottom: f64, name: &str, primary: bool) -> Screen {
        Screen {
            name: Some(name.into()),
            rect: Rect { left, top, right, bottom },
            physical: (left as i32, top as i32, (right - left) as u32, (bottom - top) as u32),
            scale: 1.0,
            primary,
        }
    }

    #[test]
    fn finds_the_monitor_under_a_point() {
        let screens = [screen(0.0, 0.0, 1920.0, 1080.0, "A", true), screen(1920.0, 0.0, 4480.0, 1440.0, "B", false)];
        assert_eq!(find_at(&screens, 100.0, 100.0), Some(0));
        assert_eq!(find_at(&screens, 1920.0, 1200.0), Some(1));
        assert_eq!(find_at(&screens, 100.0, 1200.0), None);
        assert_eq!(find_at(&screens, -5.0, 10.0), None);
    }

    #[test]
    fn open_sides_need_a_touching_monitor_that_overlaps_vertically() {
        let a = screen(0.0, 0.0, 1920.0, 1080.0, "A", true);
        let right = screen(1920.0, 200.0, 3840.0, 1280.0, "B", false);
        let below = screen(0.0, 1080.0, 1920.0, 2160.0, "C", false);
        let screens = [a.clone(), right, below];
        assert_eq!(open_sides(&screens, &a.rect), (false, true));
        let far = [a.clone(), screen(1920.0, 1080.0, 3840.0, 2160.0, "D", false)];
        assert_eq!(open_sides(&far, &a.rect), (false, false));
    }

    #[test]
    fn remembered_monitor_falls_back_to_name_then_primary() {
        let screens = [screen(0.0, 0.0, 1920.0, 1080.0, "A", true), screen(1920.0, 0.0, 3840.0, 1080.0, "B", false)];
        let at = |name: &str, x: i32| MonitorRef { name: Some(name.into()), x, y: 0 };
        assert_eq!(remembered(&screens, Some(&at("B", 1920))), Some(1));
        assert_eq!(remembered(&screens, Some(&at("B", -1920))), Some(1));
        assert_eq!(remembered(&screens, Some(&at("Z", 0))), Some(0));
        assert_eq!(remembered(&screens, None), Some(0));
        assert_eq!(remembered(&[], None), None);
    }
}
