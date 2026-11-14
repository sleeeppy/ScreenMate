import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { WindowRect } from "./behavior/platforms.ts";

/** 웹뷰 좌표(CSS px, 창 왼쪽 위 기준) 사각형 */
export interface CssRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CursorEvent {
  x: number;
  y: number;
  /** 커서가 캐릭터 관심 영역 안에 있는지 */
  near: boolean;
}

export interface StageInfo {
  width: number;
  height: number;
  scale: number;
  workArea: CssRect;
  /** 왼쪽·오른쪽에 맞닿은 모니터가 있다 (던지면 그쪽으로 넘어간다) */
  openLeft: boolean;
  openRight: boolean;
}

/** 다른 모니터로 옮긴 결과: 새 무대 정보와, 요청한 점의 새 좌표 */
export interface MonitorTransfer {
  info: StageInfo;
  x: number;
  y: number;
}

export interface ModelListing {
  id: string;
  name: string;
  group: string;
  /** models/ 기준 상대 경로 ('/' 구분) */
  file: string;
  format: "pmx" | "pmd";
  hasCache: boolean;
  profile: unknown;
  /** 전신 썸네일 (mate:// 기준 상대 경로). 아직 없으면 null */
  thumbnail: string | null;
  /** 카드 썸네일 (머리~허벅지, 3:4) */
  portrait: string | null;
  /** 썸네일에서 뽑은 모델 색 (카드 배경) */
  look: ModelLook | null;
}

/** 모델 색. 색상(hue, 0~360)과 옷의 밝기 */
export interface ModelLook {
  /** 가장 눈에 띄는 색 */
  accent: number;
  /** 두 번째 색 (없으면 accent 근처) */
  second: number;
  /** 옷이 어두운지 밝은지 */
  tone: "dark" | "light" | "mid";
}

export type ThumbnailKind = "full" | "card" | "look";

export interface Settings {
  modelId: string | null;
  heightPx: number;
  /** 두리번·기지개·걸터앉기 같은 동작을 섞는다 */
  variety: boolean;
  /** 창 위쪽 테두리에 올라서고 앉는다 */
  ledges: boolean;
  /** 입력이 없으면 이 시간(분) 뒤에 존다. 0이면 졸지 않는다 */
  sleepMinutes: number;
  /** 가까이 온 커서를 눈과 고개로 따라본다 */
  gaze: boolean;
  /** 로그인할 때 자동 시작 (운영체제 설정을 비춘 값) */
  autostart: boolean;
  /** 처음 켰을 때 보여 주는 안내를 봤다 */
  onboarded: boolean;
}

/** 캐릭터 지금 상태 (메인 창 → 설정 창 아래 막대) */
export interface MateStatus {
  modelId: string | null;
  /** 재생 중인 모션 이름 */
  motion: string;
  /** 미리보기 중이면 그 모션, 자율 행동이면 "auto" */
  preview: string;
  /** 행동 상태 (idle, walk, sit …) */
  state: string;
}

export const onCursor = (handler: (cursor: CursorEvent) => void): Promise<UnlistenFn> =>
  listen<CursorEvent>("cursor", (event) => handler(event.payload));

export const onSettingsChanged = (handler: (settings: Settings) => void): Promise<UnlistenFn> =>
  listen<Settings>("settings-changed", (event) => handler(event.payload));

export const onModelsChanged = (handler: () => void): Promise<UnlistenFn> =>
  listen("models-changed", () => handler());

export const onReload = (handler: () => void): Promise<UnlistenFn> => listen("reload", () => handler());

export const stageInfo = (): Promise<StageInfo> => invoke("stage_info");

/** 창 밖 한 점(지금 창 기준 CSS px)이 다른 모니터 위면 오버레이를 그 모니터로 옮긴다. 아니면 null. */
export const transferMonitor = (x: number, y: number): Promise<MonitorTransfer | null> =>
  invoke("transfer_monitor", { x, y });

/** 보이는 최상위 창 목록 (앞 → 뒤). 바뀔 때만 온다. */
export const onWindows = (handler: (windows: WindowRect[]) => void): Promise<UnlistenFn> =>
  listen<WindowRect[]>("windows", (event) => handler(event.payload));

/** 전체화면 앱(게임·영상)이 떴다/사라졌다. 바뀔 때만 온다. */
export const onFullscreen = (handler: (fullscreen: boolean) => void): Promise<UnlistenFn> =>
  listen<boolean>("fullscreen", (event) => handler(event.payload));

/** 지금 전체화면인지 (시작할 때 한 번) */
export const fullscreenState = (): Promise<boolean> => invoke("fullscreen_state");

/** 창 목록 폴링 속도: 캐릭터가 창 위에 있으면 빠르게 (창을 따라가야 해서) */
export const setPlatformRate = (fast: boolean): Promise<void> => invoke("set_platform_rate", { fast });

export const launchOptions = (): Promise<{
  motion: string | null;
  benchIdle: boolean;
  dropOnWindow: boolean;
  demoHang: boolean;
  backdrop: boolean;
}> =>
  invoke("launch_options");

export const onMotionPreview = (handler: (name: string) => void): Promise<UnlistenFn> =>
  listen<string>("motion-preview", (event) => handler(event.payload));

/** 진단 로그를 Rust 표준 출력으로 보낸다 (개발 중 성능 측정용) */
export function diag(message: string): void {
  void invoke("diag", { message }).catch(() => {});
}

export const setInterestRect = (rect: CssRect | null): Promise<void> =>
  invoke("set_interest_rect", { rect });
/** 마우스 버튼이 하나라도 눌려 있는지 (클릭 통과 중에도). 이 플랫폼에서 알 수 없으면 null */
export const mousePressed = (): Promise<boolean | null> => invoke("mouse_pressed");

export const listModels = (): Promise<ModelListing[]> => invoke("list_models");

/** 설정 창에서 만든 폴더 */
export interface LibraryFolder {
  id: string;
  name: string;
  /** 상위 폴더 (null이면 맨 위) */
  parent: string | null;
}

/** 모델 보관함 정리 (models/library.json) */
export interface Library {
  /** 처음 정리를 마쳤는지 */
  organized: boolean;
  /** 폴더 (보이는 순서) */
  folders: LibraryFolder[];
  /** 모델 id → 폴더 id (null이면 폴더 밖). 키가 없으면 새로 들어온 모델 */
  placement: Record<string, string | null>;
  /** 모델 id → 바꾼 이름 */
  titles: Record<string, string>;
}

export const getLibrary = (): Promise<Library> => invoke("get_library");
export const saveLibrary = (library: Library): Promise<Library> => invoke("save_library", { library });
export const onLibraryChanged = (handler: (library: Library) => void): Promise<UnlistenFn> =>
  listen<Library>("library-changed", (event) => handler(event.payload));

/** 모델을 지운다 (가져온 사본·캐시·썸네일). 지운 개수를 돌려준다 */
export const deleteModels = (ids: string[]): Promise<number> => invoke("delete_models", { ids });

export const getSettings = (): Promise<Settings> => invoke("get_settings");

export const updateSettings = (patch: Partial<Omit<Settings, "modelId">>): Promise<Settings> =>
  invoke("update_settings", { patch });

export const selectModel = (id: string): Promise<Settings> => invoke("select_model", { id });

export const saveThumbnail = (id: string, kind: ThumbnailKind, bytes: ArrayBuffer): Promise<void> =>
  invoke("save_thumbnail", new Uint8Array(bytes), {
    headers: { "x-model-id": encodeURIComponent(id), "x-thumb-kind": kind },
  });

/** GitHub 최신 릴리스와 지금 버전을 비교한 결과 */
export interface UpdateStatus {
  current: string;
  latest: string | null;
  /** 더 새로운 릴리스가 있다 */
  available: boolean;
  /** 받은 파일로 지금 앱을 그 자리에서 바꿀 수 있다 */
  installable: boolean;
  /** 설치할 수 없을 때 이유 */
  reason: string | null;
  page: string | null;
}

export interface UpdateProgress {
  phase: "download" | "install";
  fraction: number;
}

export const checkForUpdate = (): Promise<UpdateStatus> => invoke("check_for_update");
export const installUpdate = (): Promise<void> => invoke("install_update");
export const openUpdatePage = (page: string): Promise<void> => invoke("open_update_page", { page });
export const onUpdateProgress = (handler: (progress: UpdateProgress) => void): Promise<UnlistenFn> =>
  listen<UpdateProgress>("update-progress", (event) => handler(event.payload));

export const openSettingsWindow = (): Promise<void> => invoke("open_settings_window");
export const importModels = (): Promise<void> => invoke("import_models");
export const openModelsFolder = (): Promise<void> => invoke("open_models_folder");
export const openDataFolder = (): Promise<void> => invoke("open_data_folder");
export const reloadCharacter = (): Promise<void> => invoke("reload_character");
export const quitApp = (): Promise<void> => invoke("quit_app");

/** 설정 창 → 메인 창: 모션 미리보기 ("auto"면 자율 행동) */
export const requestMotionPreview = (name: string): Promise<void> => emit("motion-preview", name);
/** 설정 창 → 메인 창: 지금 상태를 알려 달라 */
export const requestStatus = (): Promise<void> => emit("status-request");
export const broadcastStatus = (status: MateStatus): Promise<void> => emit("mate-status", status);
export const onStatus = (handler: (status: MateStatus) => void): Promise<UnlistenFn> =>
  listen<MateStatus>("mate-status", (event) => handler(event.payload));
export const onStatusRequest = (handler: () => void): Promise<UnlistenFn> => listen("status-request", () => handler());


export const saveProfile = (id: string, profile: unknown): Promise<void> =>
  invoke("save_profile", { id, profile });

export const clearModelCache = (id: string): Promise<void> => invoke("clear_model_cache", { id });

export const saveModelCache = (id: string, bytes: ArrayBuffer): Promise<void> =>
  invoke("save_model_cache", new Uint8Array(bytes), {
    headers: { "x-model-id": encodeURIComponent(id) },
  });

/**
 * mate:// 프로토콜 URL. 경로 구분자를 살려야 텍스처 상대 경로가 풀린다.
 * 기본 주소는 플랫폼마다 다르다: Windows `http://mate.localhost/`, macOS·Linux `mate://localhost/`.
 */
export function mateUrl(relativePath: string): string {
  const encoded = relativePath.split("/").map(encodeURIComponent).join("/");
  return `${convertFileSrc("", "mate")}${encoded}`;
}
