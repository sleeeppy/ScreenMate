/**
 * 설정 창 (트레이 메뉴 대신 쓰는 GUI).
 *
 * 왼쪽: 모델 보관함. 폴더(처음엔 캐릭터별로 자동) → 폴더를 열면 그 안의 모델 카드. 폴더 밖 모델은 맨 위에.
 *   - 고르기: 클릭, ⌘/Ctrl+클릭(더하기·빼기), Shift+클릭(범위), 빈 곳에서 끌기(사각형), ⌘A(전부). 두 번 클릭은 그 모델 쓰기.
 *   - 고른 모델을 폴더 카드로 끌면 그 폴더로, 위쪽 "모델"로 끌면 폴더 밖으로 (잠깐 대고 있으면 맨 위로 열린다).
 *   - 오른쪽 클릭 메뉴: 이름 바꾸기, 폴더로 이동, 삭제 / 폴더 이름 바꾸기·삭제. Delete 키로 삭제, F2로 이름 바꾸기.
 * 오른쪽: 고른 모델 미리보기, "이 모델 쓰기", 캐릭터 설정(크기·커서 바라보기·다양한 동작·창 위에 올라가기·졸기).
 * 위쪽 "일반 설정": 로그인할 때 자동 시작, 업데이트, 데이터 폴더, 종료처럼 캐릭터와 상관없는 앱 설정.
 * 설정은 Rust(settings.json), 폴더·이름은 Rust(models/library.json)가 갖고 있고 바뀌면 모든 창에 퍼진다.
 */
import { getVersion } from "@tauri-apps/api/app";
import appIcon from "../../src-tauri/icons/128x128.png";
import appIconLarge from "../../src-tauri/icons/128x128@2x.png";
import {
  checkForUpdate,
  deleteModels,
  diag,
  getLibrary,
  installUpdate,
  getSettings,
  importModels,
  listModels,
  mateUrl,
  onLibraryChanged,
  onModelsChanged,
  onSettingsChanged,
  onUpdateProgress,
  openDataFolder,
  openModelsFolder,
  openUpdatePage,
  quitApp,
  saveLibrary,
  selectModel,
  updateSettings,
  type Library,
  type ModelListing,
  type Settings,
  type UpdateStatus,
} from "../ipc";
import {
  childFolders,
  createFolder,
  deleteFolders,
  descendants,
  emptyLibrary,
  folderOf,
  folderPath,
  modelsIn,
  modelsUnder,
  moveFolder,
  moveTo,
  organize,
  renameFolder,
  renameModel,
  titleOf,
} from "./library";
import "../platformFont";
import "./settings.css";
import { makeMissingThumbnails, needsThumbnail } from "./thumbnails";
import { openTour, type Tour } from "./tour";

const SIZES = [
  { label: "작게", value: 200 },
  { label: "보통", value: 260 },
  { label: "크게", value: 340 },
];
const HEIGHT_MIN = 160;
const HEIGHT_MAX = 440;
/** 슬라이더를 끄는 동안 화면 캐릭터에 보내는 간격 (ms). 크기를 바꿀 때마다 물리를 다시 놓아서 너무 자주 보내면 머리카락이 튄다 */
const HEIGHT_SEND_INTERVAL = 70;
const SLEEP_CHOICES = [
  { label: "끄기", value: 0 },
  { label: "5분", value: 5 },
  { label: "10분", value: 10 },
  { label: "30분", value: 30 },
];
/** 이만큼(px) 움직여야 클릭이 아니라 끌기 */
const DRAG_START = 6;
/** 두 번 클릭으로 칠 간격 (ms) */
const DOUBLE_CLICK_MS = 400;
/** 끌면서 위쪽 경로(모델 / 폴더 …)에 이만큼(ms) 대고 있으면 그 폴더를 연다 */
const SPRING_MS = 600;
/** 끌면서 폴더 카드에 이만큼(ms) 대고 있으면 그 폴더를 연다 (안쪽 폴더에 넣을 수 있게) */
const SPRING_FOLDER_MS = 900;

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  folderPlus: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M12 10.5v5M9.5 13h5"/>',
  check: '<path d="m5.5 12.5 4 4 9-9"/>',
  back: '<path d="m14.5 6-6 6 6 6"/>',
  pencil: '<path d="M15.5 5.5l3 3L9 18H6v-3z"/><path d="m13.5 7.5 3 3"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
  close: '<path d="m7 7 10 10M17 7 7 17"/>',
  move: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="m11 11.5 2.5 2-2.5 2M8 13.5h5.5"/>',
  out: '<path d="M14 5h5v5M19 5l-8 8"/><path d="M17 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4"/>',
  play: '<path d="M8 6v12l10-6z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4 6 18M18 18l-1.6-1.6M7.6 7.6 6 6"/>',
  power: '<path d="M12 4v8"/><path d="M7.5 6.8a7 7 0 1 0 9 0"/>',
};

function icon(name: keyof typeof ICONS, size = 16): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

// ------------------------------------------------------------------ 상태

type Renaming = { kind: "model" | "folder"; id: string; where: "tile" | "inspector" };

const state = {
  models: [] as ModelListing[],
  library: emptyLibrary() as Library,
  settings: null as Settings | null,
  /** 열어 둔 폴더 id (null이면 맨 위) */
  folder: null as string | null,
  /** 오른쪽에 보이는 모델 (없으면 쓰는 중인 모델) */
  inspectId: null as string | null,
  /** 고른 모델 (여러 개 가능) */
  selected: new Set<string>(),
  /** Shift+클릭 범위의 시작 */
  anchor: null as string | null,
  renaming: null as Renaming | null,
  version: "",
  thumbVersion: Date.now(),
  /** 썸네일 만드는 중이면 진행 상황 */
  progress: null as { done: number; total: number } | null,
};

const root = document.querySelector<HTMLDivElement>("#app")!;
let toastTimer = 0;

function toast(message: string): void {
  let element = document.querySelector<HTMLDivElement>(".toast");
  if (!element) {
    element = document.createElement("div");
    element.className = "toast";
    document.body.append(element);
  }
  element.textContent = message;
  element.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => element!.classList.remove("show"), 1800);
}

function hashOf(text: string): number {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}

/**
 * 모델 카드 배경: 썸네일에서 뽑은 옷 색으로 만든 그라디언트와 빛 (settings.css `.look`).
 * 바탕은 두 번째 색, 캐릭터 뒤 빛은 대표 색. 어두운 옷은 깊은 바탕, 밝은 옷은 밝은 바탕.
 */
function lookStyle(model: ModelListing): string {
  const seed = hashOf(model.id);
  const look = model.look ?? { accent: seed % 360, second: (seed + 40) % 360, tone: "mid" as const };
  const a = Math.round(look.accent);
  // 노랑·연두는 어둡게 칠하면 탁한 올리브가 되어 바탕으로는 맞은편 색을 쓴다. 같은 색끼리도 조금씩 다르게
  const nudge = ((seed % 3) - 1) * 14;
  const b = Math.round((isYellow(look.second) ? look.second + 180 : look.second) + nudge + 360) % 360;
  const [base, top, glow, glow2] =
    look.tone === "dark"
      ? [`hsl(${b}, 26%, 10%)`, `hsl(${b}, 24%, 18%)`, `hsla(${a}, 70%, 60%, 0.2)`, `hsla(${b}, 55%, 55%, 0.14)`]
      : look.tone === "light"
        ? [`hsl(${b}, 14%, 22%)`, `hsl(${b}, 16%, 33%)`, `hsla(${a}, 70%, 85%, 0.22)`, "hsla(0, 0%, 100%, 0.08)"]
        : [`hsl(${b}, 22%, 12%)`, `hsl(${b}, 22%, 21%)`, `hsla(${a}, 70%, 62%, 0.2)`, `hsla(${b}, 55%, 58%, 0.14)`];
  // 빛 방향을 모델마다 조금씩 다르게
  const tilt = (seed % 5) * 9 - 18;
  return `--base:${base};--top:${top};--glow:${glow};--glow2:${glow2};--tilt:${150 + tilt}deg`;
}

function isYellow(hue: number): boolean {
  return hue >= 30 && hue <= 100;
}

function picture(path: string | null): string {
  if (!path) return `<div class="placeholder"><span class="shimmer"></span></div>`;
  // decoding=sync: 다시 그릴 때 이미 받아 둔 그림이 한 프레임 비었다가 나타나지 않게
  return `<img src="${mateUrl(path)}?v=${state.thumbVersion}" alt="" draggable="false" decoding="sync" />`;
}

/** 카드 그림: 상반신 (없으면 전신) */
function portrait(model: ModelListing): string {
  return picture(model.portrait ?? model.thumbnail);
}

function modelById(id: string | null): ModelListing | undefined {
  return id ? state.models.find((model) => model.id === id) : undefined;
}

function activeModel(): ModelListing | undefined {
  return modelById(state.settings?.modelId ?? null);
}

function folderById(id: string | null) {
  return id ? state.library.folders.find((folder) => folder.id === id) : undefined;
}

function title(model: ModelListing): string {
  return titleOf(state.library, model);
}

/** 지금 보이는 모델 (열어 둔 폴더 안, 맨 위면 폴더 밖 모델) */
function visibleModels(): ModelListing[] {
  return modelsIn(state.library, state.models, state.folder);
}

// ------------------------------------------------------------------ 그리기

function render(): void {
  rememberScroll();
  root.innerHTML = `
    <div class="app">
      <header class="titlebar" data-tauri-drag-region>
        <div class="brand" data-tauri-drag-region>
          <img src="${appIcon}" alt="" />ScreenMate <span class="version">${escape(state.version)}</span>
        </div>
        <div class="tools">
          <button class="chip" data-action="general" title="일반 설정">${icon("gear", 14)}일반 설정</button>
          <button class="chip" data-action="open-models" title="가져온 모델 폴더 열기">${icon("folder", 14)}</button>
          <button class="chip" data-action="import">${icon("plus", 14)}모델 가져오기</button>
        </div>
      </header>
      <main class="body">
        <section class="content-wrap ${state.selected.size >= 2 ? "multi" : ""}">
          <div class="content">${renderView()}</div>
          ${renderSelectionBar()}
        </section>
        <aside class="inspector">${renderInspector()}</aside>
      </main>
    </div>`;
  bind();
  // 다시 그려도 스크롤은 그대로 (왼쪽은 다른 폴더로 갔을 때만 맨 위로)
  const content = root.querySelector(".content");
  const inspector = root.querySelector(".inspector");
  if (content && state.folder === scroll.folder) content.scrollTop = scroll.content;
  // 폴더를 열면 오른쪽에서, 나오면 왼쪽에서 살짝 밀려 들어온다
  else content?.classList.add(state.folder ? "enter-forward" : "enter-back");
  if (inspector) inspector.scrollTop = scroll.inspector;
  scroll.folder = state.folder;
  focusRename();
  paintUpdate();
}

/** 오른쪽만 다시 그린다 (고른 모델이 바뀌었을 때) */
function renderInspectorOnly(): void {
  const inspector = root.querySelector<HTMLElement>(".inspector");
  if (!inspector) return render();
  const top = inspector.scrollTop;
  inspector.innerHTML = renderInspector();
  inspector.scrollTop = top;
  bind(inspector);
  focusRename();
}

const scroll = { folder: null as string | null, content: 0, inspector: 0 };

function rememberScroll(): void {
  scroll.content = root.querySelector(".content")?.scrollTop ?? 0;
  scroll.inspector = root.querySelector(".inspector")?.scrollTop ?? 0;
}

/** 지금 폴더(맨 위면 null)의 경로·폴더 카드·모델 카드 */
function renderView(): string {
  if (state.folder && !folderById(state.folder)) state.folder = null;
  if (state.models.length === 0 && state.library.folders.length === 0) {
    return `<div class="empty">가져온 모델이 없어요.<br />오른쪽 위 <b>모델 가져오기</b>로 .pmx·.pmd가 들어 있는 폴더를 고르세요.</div>`;
  }
  const current = state.folder;
  const folders = childFolders(state.library, current);
  const models = visibleModels();
  const path = folderPath(state.library, current);
  const here = path[path.length - 1];
  const crumbs = here
    ? `<button class="crumb-back" data-nav="" data-drop="" title="맨 위로 · 여기로 끌어 놓으면 맨 위로 옮겨요">${icon("back", 15)}모델</button>` +
      path
        .slice(0, -1)
        .map(
          (folder) =>
            `<span class="sep">/</span><button class="crumb-link" data-nav="${escape(folder.id)}" data-drop="${escape(folder.id)}">${escape(folder.name)}</button>`,
        )
        .join("") +
      `<span class="sep">/</span><span class="here">${escape(here.name)}</span><span class="count">${folders.length + models.length}</span>`
    : `<span class="here">모델</span><span class="count">${state.models.length}</span>`;
  const cards = folders.map(folderTile).join("") + models.map(modelTile).join("");
  return `
    <div class="crumbs">
      ${crumbs}
      <span class="crumb-tools">
        ${progressNote()}
        <button class="chip small" data-act="new-folder" data-drop="new" title="새 폴더 (여기로 끌어 놓으면 새 폴더에 넣어요)">${icon("folderPlus", 14)}새 폴더</button>
      </span>
    </div>
    ${
      cards
        ? `<div class="grid">${cards}</div>`
        : `<div class="empty">빈 폴더예요.<br />모델이나 폴더를 끌어다 놓거나, 빈 곳을 오른쪽 클릭해 새 폴더를 만들 수 있어요.</div>`
    }`;
}

function folderTile(folder: { id: string; name: string }): string {
  const active = activeModel();
  const inside = modelsUnder(state.library, state.models, folder.id);
  const subfolders = childFolders(state.library, folder.id).length;
  const using = active ? inside.includes(active) : false;
  // 쓰는 중인 모델을 맨 앞(왼쪽 위)에
  const ordered = using && active ? [active, ...inside.filter((model) => model !== active)] : inside;
  const renaming = state.renaming?.kind === "folder" && state.renaming.id === folder.id;
  const meta = [inside.length ? `모델 ${inside.length}개` : "", subfolders ? `폴더 ${subfolders}개` : ""].filter(Boolean).join(" · ");
  return `
    <div class="tile folder ${using ? "holds-active" : ""}" data-folder-id="${escape(folder.id)}" data-drop="${escape(folder.id)}">
      <div class="art">
        ${inside.length ? mosaic(ordered) : `<div class="empty-folder">${icon("folder", 34)}<span>${subfolders ? `폴더 ${subfolders}개` : "비어 있음"}</span></div>`}
      </div>
      ${
        renaming
          ? renameInput(folder.name)
          : // "사용 중" 배지는 모델 카드에만. 폴더는 안에 쓰는 모델이 있다는 작은 점만 (폴더마다 배지가 겹쳐 보이지 않게)
            `<div class="name">${using ? `<span class="in-use-dot" title="쓰는 중인 모델이 이 안에 있어요"></span>` : ""}${escape(folder.name)}</div>`
      }
      <div class="meta">${meta || "비어 있음"}</div>
    </div>`;
}

/**
 * 폴더 카드 그림: 안에 든 모델을 최대 4칸으로 나눠 보여 준다.
 * 1개는 통째로, 2개는 좌우 반씩, 3개는 왼쪽 큰 칸 + 오른쪽 두 칸, 4개 이상은 2×2 (넘치면 마지막 칸에 +N).
 * 세로로 긴 칸은 전신, 3:4에 가까운 칸은 카드(머리~허벅지) 그림을 쓴다.
 */
function mosaic(models: ModelListing[]): string {
  const shown = models.slice(0, 4);
  const extra = models.length - shown.length;
  const tall = (index: number) => shown.length === 2 || (shown.length === 3 && index === 0);
  const cells = shown
    .map((model, index) => {
      const art = tall(index) ? picture(model.thumbnail ?? model.portrait) : portrait(model);
      const more = extra > 0 && index === shown.length - 1 ? `<span class="more">+${extra}</span>` : "";
      return `<div class="cell look ${tall(index) ? "tall" : ""}" style="${lookStyle(model)}">${art}${more}</div>`;
    })
    .join("");
  return `<div class="mosaic n${shown.length}">${cells}</div>`;
}

function modelTile(model: ModelListing): string {
  const activeId = state.settings?.modelId;
  const selected = state.selected.has(model.id);
  const renaming = state.renaming?.kind === "model" && state.renaming.where === "tile" && state.renaming.id === model.id;
  return `
    <div class="tile model ${model.id === activeId ? "active" : ""} ${selected ? "selected" : ""}" data-model="${escape(model.id)}" title="두 번 누르면 바로 써요">
      <div class="art look" style="${lookStyle(model)}">
        ${portrait(model)}
        ${model.id === activeId ? `<span class="badge">${icon("check", 11)}사용 중</span>` : ""}
        <span class="check">${icon("check", 12)}</span>
      </div>
      ${renaming ? renameInput(title(model)) : `<div class="name"><span>${escape(title(model))}</span></div>`}
      <div class="meta">${escape(model.group)}</div>
    </div>`;
}

function renameInput(value: string): string {
  return `<input class="rename" value="${escape(value)}" spellcheck="false" maxlength="80" />`;
}

function progressNote(): string {
  const progress = state.progress;
  if (!progress) return "";
  return `<span class="progress"><span class="spinner small"></span>썸네일 만드는 중 ${Math.min(progress.done + 1, progress.total)}/${progress.total}</span>`;
}



function renderSelectionBar(): string {
  const count = state.selected.size;
  return `
    <div class="selection-bar ${count >= 2 ? "show" : ""}">
      <span class="label">${count}개 선택</span>
      <button data-act="move-selection">${icon("move", 15)}폴더로 이동</button>
      <button data-act="delete-selection" class="danger">${icon("trash", 15)}삭제</button>
      <button data-act="clear-selection" class="close" title="선택 해제 (esc)">${icon("close", 14)}</button>
    </div>`;
}

function renderInspector(): string {
  const settings = state.settings;
  if (!settings) return "";
  const model = modelById(state.inspectId) ?? activeModel() ?? state.models[0];
  const using = model?.id === settings.modelId;
  const where = model
    ? folderPath(state.library, folderOf(state.library, model.id))
        .map((folder) => folder.name)
        .join(" / ") || "폴더 밖"
    : "";
  const renaming = model && state.renaming?.kind === "model" && state.renaming.where === "inspector" && state.renaming.id === model.id;
  const head = model
    ? `
      <div class="preview look" style="${lookStyle(model)}">${picture(model.thumbnail)}</div>
      <div class="title-row">
        <div class="title">
          ${renaming ? renameInput(title(model)) : `<h2 title="${escape(title(model))}">${escape(title(model))}</h2>`}
          <div class="sub">${escape(where)} · ${escape(model.group)} · ${model.format.toUpperCase()}</div>
        </div>
        <div class="title-actions">
          <button class="icon-button small" data-act="rename-inspected" title="이름 바꾸기 (F2)">${icon("pencil", 15)}</button>
          <button class="icon-button small danger" data-act="delete-inspected" title="모델 삭제">${icon("trash", 15)}</button>
        </div>
      </div>
      <button class="button primary block" data-use="${escape(model.id)}" ${using ? "disabled" : ""}>
        ${using ? `${icon("check", 15)}적용 중` : `이 모델 쓰기<span class="kbd">↩</span>`}
      </button>`
    : "";
  return `
    ${head}
    <div class="panel">
      <div class="panel-row">
        <div class="text"><div class="label">크기</div></div>
        <div class="choices">${SIZES.map(
          (size) =>
            `<button data-size="${size.value}" class="${Math.abs(settings.heightPx - size.value) < 0.5 ? "active" : ""}">${size.label}</button>`,
        ).join("")}</div>
      </div>
      <div class="slider-row">
        <input id="height" type="range" min="${HEIGHT_MIN}" max="${HEIGHT_MAX}" step="1" value="${settings.heightPx}" style="--fill:${fillOf(settings.heightPx)}" />
        <span class="value" id="height-value">${Math.round(settings.heightPx)}px</span>
      </div>
      ${toggle("gaze", "커서 바라보기", "가까이 온 커서를 눈과 고개로 따라봐요", settings.gaze)}
      ${toggle("variety", "다양한 동작", "창에 뛰어오르기, 화면 밖에서 엿보기, 앉아서 쉬기", settings.variety)}
      ${toggle("ledges", "창 위에 올라가기", "창 위에 내려앉고 걷고 걸터앉아요", settings.ledges)}
      <div class="panel-row stacked">
        <div class="text"><div class="label">입력이 없으면 졸기</div></div>
        <div class="choices">${SLEEP_CHOICES.map(
          (choice) => `<button data-sleep="${choice.value}" class="${settings.sleepMinutes === choice.value ? "active" : ""}">${choice.label}</button>`,
        ).join("")}</div>
      </div>
    </div>`;
}

function toggle(key: ToggleKey, label: string, hint: string, on: boolean): string {
  return `
    <div class="panel-row clickable" data-toggle="${key}">
      <div class="text"><div class="label">${label}</div><div class="hint">${hint}</div></div>
      <span class="switch ${on ? "on" : ""}" role="switch" aria-checked="${on}" aria-label="${label}"></span>
    </div>`;
}

// ------------------------------------------------------------------ 고르기

/** 고른 상태만 카드에 반영한다 (다시 그리지 않음) */
function syncSelection(): void {
  root.querySelectorAll<HTMLElement>("[data-model]").forEach((tile) =>
    tile.classList.toggle("selected", state.selected.has(tile.dataset.model!)),
  );
  root.querySelector(".content-wrap")?.classList.toggle("multi", state.selected.size >= 2);
  const bar = root.querySelector(".selection-bar");
  if (bar) {
    bar.classList.toggle("show", state.selected.size >= 2);
    bar.querySelector(".label")!.textContent = `${state.selected.size}개 선택`;
  }
}

function inspect(id: string): void {
  if (state.inspectId === id) return;
  state.inspectId = id;
  renderInspectorOnly();
}

function selectOnly(id: string): void {
  state.selected = new Set([id]);
  state.anchor = id;
  syncSelection();
  inspect(id);
}

function toggleSelected(id: string): void {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  state.anchor = id;
  syncSelection();
  if (state.selected.has(id)) inspect(id);
}

function selectRange(id: string): void {
  const order = visibleModels().map((model) => model.id);
  const from = order.indexOf(state.anchor ?? id);
  const to = order.indexOf(id);
  if (from < 0 || to < 0) return selectOnly(id);
  const [start, end] = from < to ? [from, to] : [to, from];
  state.selected = new Set(order.slice(start, end + 1));
  syncSelection();
  inspect(id);
}

function selectAll(): void {
  const models = visibleModels();
  if (!models.length) return;
  state.selected = new Set(models.map((model) => model.id));
  syncSelection();
}

function clearSelection(): void {
  state.selected.clear();
  syncSelection();
}

// ------------------------------------------------------------------ 끌기 (모델 → 폴더), 사각형 고르기

let lastClick = { id: "", time: 0 };

function onPointerDown(event: PointerEvent): void {
  const target = event.target as Element;
  if (!target.closest(".menu")) closeMenu();
  if (event.button !== 0 || target.closest("input, .dialog, .menu, .selection-bar")) return;
  const content = target.closest(".content");
  if (!content) return;
  const tile = target.closest<HTMLElement>("[data-model]");
  const folderTile = target.closest<HTMLElement>("[data-folder-id]");
  if (tile) modelGesture(event, tile.dataset.model!);
  else if (folderTile) folderGesture(event, folderTile.dataset.folderId!);
  else if (!target.closest("button, .crumbs")) marquee(event, content as HTMLElement);
}

function modelGesture(event: PointerEvent, id: string): void {
  const additive = event.metaKey || event.ctrlKey;
  const wasSelected = state.selected.has(id);
  if (event.shiftKey) selectRange(id);
  else if (additive) toggleSelected(id);
  else if (!wasSelected) selectOnly(id);
  else inspect(id);
  const start = { x: event.clientX, y: event.clientY };
  let drag: Drag | null = null;
  const move = (moveEvent: PointerEvent) => {
    if (!drag && Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) >= DRAG_START) {
      if (!state.selected.has(id)) {
        state.selected.add(id);
        syncSelection();
      }
      drag = startDrag({ models: [...state.selected], folders: [] });
    }
    drag?.move(moveEvent.clientX, moveEvent.clientY);
  };
  const up = (upEvent: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (drag) {
      drag.drop(upEvent.clientX, upEvent.clientY);
      return;
    }
    // 고른 여러 개 중 하나를 그냥 누르면 그것만 고른다 (끌기를 위해 누를 때는 그대로 둔다)
    if (!additive && !event.shiftKey && wasSelected) selectOnly(id);
    const now = performance.now();
    if (!additive && !event.shiftKey && lastClick.id === id && now - lastClick.time < DOUBLE_CLICK_MS) {
      lastClick = { id: "", time: 0 };
      void use(id);
    } else {
      lastClick = { id, time: now };
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/** 폴더 카드: 누르면 열고, 끌면 폴더째 옮긴다 */
function folderGesture(event: PointerEvent, id: string): void {
  const start = { x: event.clientX, y: event.clientY };
  let drag: Drag | null = null;
  const move = (moveEvent: PointerEvent) => {
    if (!drag && Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) >= DRAG_START) {
      drag = startDrag({ models: [], folders: [id] });
    }
    drag?.move(moveEvent.clientX, moveEvent.clientY);
  };
  const up = (upEvent: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (drag) drag.drop(upEvent.clientX, upEvent.clientY);
    else openFolder(id);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

interface Drag {
  move(x: number, y: number): void;
  drop(x: number, y: number): void;
}

/** 끄는 것: 고른 모델들, 또는 폴더 */
interface Payload {
  models: string[];
  folders: string[];
}

/** 이 폴더(null이면 맨 위)에 놓을 수 있는지: 폴더는 자기 자신·자기 아래로 못 간다 */
function canDropInto(payload: Payload, destination: string | null): boolean {
  if (destination === null) return true;
  return !payload.folders.some((id) => id === destination || descendants(state.library, id).includes(destination));
}

/** 끈다: 커서를 따라오는 카드 묶음 + 개수, 놓을 곳(폴더 카드·위쪽 경로·새 폴더) 강조. 대고 있으면 그 폴더가 열린다 */
function startDrag(payload: Payload): Drag {
  const models = payload.models.map((id) => modelById(id)).filter((model): model is ModelListing => !!model);
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost";
  const folderCards = payload.folders
    .slice(0, 3)
    .map((_, index) => `<div class="card folder-card" style="--i:${index}">${icon("folder", 30)}</div>`);
  const modelCards = models
    .slice(0, 3)
    .map((model, index) => `<div class="card look" style="${lookStyle(model)};--i:${index}">${portrait(model)}</div>`);
  ghost.innerHTML = `${[...folderCards, ...modelCards].slice(0, 3).join("")}<span class="count">${payload.folders.length + models.length}</span>`;
  document.body.append(ghost);
  document.body.classList.add("dragging");
  let over: HTMLElement | null = null;
  let springTimer = 0;
  const targetAt = (x: number, y: number) => {
    ghost.style.display = "none";
    const element = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop]") ?? null;
    ghost.style.display = "";
    if (!element) return null;
    const destination = element.dataset.drop ?? "";
    if (destination !== "new" && !canDropInto(payload, destination || null)) return null;
    return element;
  };
  const highlight = (element: HTMLElement | null) => {
    if (element === over) return;
    over?.classList.remove("drop-hover");
    window.clearTimeout(springTimer);
    over = element;
    over?.classList.add("drop-hover");
    // 위쪽 경로나 폴더 카드에 대고 있으면 그 폴더를 열어 더 안쪽·다른 곳에 놓을 수 있게
    const nav = over?.dataset.nav;
    const folderTile = over?.dataset.folderId;
    if (nav !== undefined && (nav || null) !== state.folder) {
      springTimer = window.setTimeout(() => {
        over = null;
        openFolder(nav || null);
      }, SPRING_MS);
    } else if (folderTile) {
      springTimer = window.setTimeout(() => {
        over = null;
        openFolder(folderTile);
      }, SPRING_FOLDER_MS);
    }
  };
  return {
    move(x, y) {
      ghost.style.transform = `translate(${x + 14}px, ${y + 10}px)`;
      highlight(targetAt(x, y));
    },
    drop(x, y) {
      const target = targetAt(x, y);
      highlight(null);
      ghost.remove();
      document.body.classList.remove("dragging");
      if (!target) return;
      const destination = target.dataset.drop ?? "";
      if (destination === "new") void newFolder(payload);
      else void moveItems(payload, destination || null);
    },
  };
}

/** 빈 곳에서 끌어 사각형 안 모델을 고른다 (⌘/Ctrl·Shift를 누르면 지금 고른 것에 더한다) */
function marquee(event: PointerEvent, content: HTMLElement): void {
  const additive = event.metaKey || event.ctrlKey || event.shiftKey;
  const base = additive ? new Set(state.selected) : new Set<string>();
  if (!additive && state.selected.size) clearSelection();
  const origin = content.getBoundingClientRect();
  const point = (x: number, y: number) => ({ x: x - origin.left + content.scrollLeft, y: y - origin.top + content.scrollTop });
  const start = point(event.clientX, event.clientY);
  let box: HTMLDivElement | null = null;
  const tiles = [...content.querySelectorAll<HTMLElement>("[data-model]")].map((tile) => {
    const rect = tile.getBoundingClientRect();
    return { id: tile.dataset.model!, ...point(rect.left, rect.top), w: rect.width, h: rect.height };
  });
  const move = (moveEvent: PointerEvent) => {
    const now = point(moveEvent.clientX, moveEvent.clientY);
    if (!box && Math.hypot(now.x - start.x, now.y - start.y) < DRAG_START) return;
    if (!box) {
      box = document.createElement("div");
      box.className = "marquee";
      content.append(box);
    }
    const left = Math.min(start.x, now.x);
    const top = Math.min(start.y, now.y);
    const width = Math.abs(now.x - start.x);
    const height = Math.abs(now.y - start.y);
    Object.assign(box.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    const hits = tiles.filter((tile) => tile.x < left + width && tile.x + tile.w > left && tile.y < top + height && tile.y + tile.h > top);
    state.selected = new Set([...base, ...hits.map((tile) => tile.id)]);
    syncSelection();
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    box?.remove();
    const last = [...state.selected].pop();
    if (last) inspect(last);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// ------------------------------------------------------------------ 오른쪽 클릭 메뉴

interface MenuItem {
  label: string;
  icon?: keyof typeof ICONS;
  danger?: boolean;
  disabled?: boolean;
  run?: () => void;
}
type MenuEntry = MenuItem | "-";

function closeMenu(): void {
  document.querySelector(".menu")?.remove();
}

function openMenu(x: number, y: number, entries: MenuEntry[], heading?: string): void {
  closeMenu();
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.innerHTML =
    (heading ? `<div class="menu-heading">${escape(heading)}</div>` : "") +
    entries
      .map((entry, index) =>
        entry === "-"
          ? `<div class="menu-sep"></div>`
          : `<button data-index="${index}" class="${entry.danger ? "danger" : ""}" ${entry.disabled ? "disabled" : ""}>${entry.icon ? icon(entry.icon, 15) : `<span class="menu-gap"></span>`}${escape(entry.label)}</button>`,
      )
      .join("");
  document.body.append(menu);
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
  menu.addEventListener("click", (clickEvent) => {
    const button = (clickEvent.target as Element).closest<HTMLButtonElement>("button[data-index]");
    if (!button || button.disabled) return;
    const entry = entries[Number(button.dataset.index)];
    closeMenu();
    if (entry !== "-") entry.run?.();
  });
}

function onContextMenu(event: MouseEvent): void {
  event.preventDefault();
  const target = event.target as Element;
  if (target.closest("input")) return;
  const tile = target.closest<HTMLElement>("[data-model]");
  const folderTile = target.closest<HTMLElement>("[data-folder-id]");
  if (tile && target.closest(".content")) {
    const id = tile.dataset.model!;
    if (!state.selected.has(id)) selectOnly(id);
    openMenu(event.clientX, event.clientY, modelMenu([...state.selected]));
  } else if (folderTile) {
    const id = folderTile.dataset.folderId!;
    openMenu(event.clientX, event.clientY, [
      { label: "열기", icon: "folder", run: () => openFolder(id) },
      { label: "이름 바꾸기", icon: "pencil", run: () => startRename({ kind: "folder", id, where: "tile" }) },
      { label: "폴더로 이동…", icon: "move", run: () => chooseFolder({ models: [], folders: [id] }) },
      "-",
      { label: "폴더 삭제", icon: "trash", danger: true, run: () => void removeFolder(id) },
    ]);
  } else if (target.closest(".content-wrap")) {
    // 빈 곳: 맨 위든 폴더 안이든 지금 보는 곳에 새 폴더
    openMenu(event.clientX, event.clientY, [
      { label: "새 폴더", icon: "folderPlus", run: () => void newFolder({ models: [], folders: [] }) },
      { label: "모델 가져오기", icon: "plus", run: () => void importModels() },
    ]);
  }
}

function modelMenu(ids: string[]): MenuEntry[] {
  const single = ids.length === 1 ? modelById(ids[0]) : undefined;
  const payload = { models: ids, folders: [] };
  const entries: MenuEntry[] = [];
  if (single) {
    entries.push(
      { label: "이 모델 쓰기", icon: "play", disabled: single.id === state.settings?.modelId, run: () => void use(single.id) },
      { label: "이름 바꾸기", icon: "pencil", run: () => startRename({ kind: "model", id: single.id, where: "tile" }) },
      "-",
    );
  }
  entries.push({ label: "폴더로 이동…", icon: "move", run: () => chooseFolder(payload) });
  if (state.folder) {
    const parent = folderById(folderById(state.folder)?.parent ?? null);
    entries.push({
      label: parent ? `‘${parent.name}’(으)로 꺼내기` : "폴더 밖으로 꺼내기",
      icon: "out",
      run: () => void moveItems(payload, parent?.id ?? null),
    });
  }
  entries.push(
    { label: ids.length > 1 ? `새 폴더로 묶기` : "새 폴더에 넣기", icon: "folderPlus", run: () => void newFolder(payload) },
    "-",
    { label: ids.length > 1 ? `모델 ${ids.length}개 삭제` : "삭제", icon: "trash", danger: true, run: () => void removeModels(ids) },
  );
  return entries;
}

/** 옮길 폴더 고르기 (선택 막대·메뉴에서). 폴더 안 폴더는 경로로 보인다. 마지막으로 연 메뉴 자리, 없으면 at */
function chooseFolder(payload: Payload, at?: { x: number; y: number }): void {
  const position = at ?? lastMenuPoint;
  const label = (id: string) => folderPath(state.library, id).map((folder) => folder.name).join(" / ");
  const entries: MenuEntry[] = state.library.folders
    .filter((folder) => folder.id !== state.folder && canDropInto(payload, folder.id))
    .filter((folder) => !payload.folders.some((id) => folderById(id)?.parent === folder.id))
    .map((folder) => ({ id: folder.id, label: label(folder.id) }))
    .sort((a, b) => a.label.localeCompare(b.label, "ko"))
    .map((folder) => ({ label: folder.label, icon: "folder" as const, run: () => void moveItems(payload, folder.id) }));
  const atTop = payload.folders.length ? payload.folders.every((id) => !folderById(id)?.parent) : state.folder === null;
  if (!atTop) entries.unshift({ label: "맨 위 (폴더 밖)", icon: "out", run: () => void moveItems(payload, null) });
  if (entries.length) entries.push("-");
  entries.push({ label: "새 폴더…", icon: "folderPlus", run: () => void newFolder(payload) });
  const count = payload.models.length + payload.folders.length;
  openMenu(position.x, position.y, entries, payload.folders.length ? "폴더 옮기기" : `모델 ${count}개 옮기기`);
}

let lastMenuPoint = { x: 200, y: 200 };

// ------------------------------------------------------------------ 업데이트

type UpdatePhase = "checking" | "idle" | "downloading" | "installing" | "error";

/** 확인 결과와 지금 단계. 확인·받기는 Rust가 따로 돌려서 그동안에도 창은 그대로 움직인다 */
const updateState: { status: UpdateStatus | null; phase: UpdatePhase; fraction: number; message: string } = {
  status: null,
  phase: "checking",
  fraction: 0,
  message: "",
};

const UPDATE_ICONS = {
  check: '<path d="m5.5 12.5 4 4 9-9"/>',
  up: '<path d="M12 19V6M6.5 11.5 12 6l5.5 5.5"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.2v.3"/>',
};

/** 업데이트 줄: 아이콘(상태 색) · 무슨 상황인지 한 줄 · 버튼 하나 (상황마다 할 수 있는 일) · 받는 중이면 진행 막대 */
function paintUpdate(): void {
  const chip = root.querySelector("[data-action='general']");
  chip?.classList.toggle("has-update", updateState.status?.available === true && updateState.phase === "idle");
  const row = document.querySelector<HTMLElement>("#update-row");
  if (!row) return;
  const iconBox = row.querySelector<HTMLElement>(".update-icon")!;
  const hint = row.querySelector<HTMLElement>("#update-hint")!;
  const button = row.querySelector<HTMLButtonElement>("[data-general='update']")!;
  const bar = row.querySelector<HTMLElement>(".update-bar")!;
  const status = updateState.status;
  const latest = status?.latest ? status.latest.replace(/^v/i, "v") : null;
  let tone: "busy" | "ok" | "new" | "error" | "muted" = "muted";
  let text = "";
  let label = "다시 확인";
  let primary = false;
  let disabled = false;
  switch (updateState.phase) {
    case "checking":
      tone = "busy";
      text = "새 버전이 있는지 확인하고 있어요";
      label = "확인 중";
      disabled = true;
      break;
    case "downloading":
      tone = "busy";
      text = `${latest ?? "새 버전"} 받는 중 · ${Math.round(updateState.fraction * 100)}%`;
      label = "받는 중";
      disabled = true;
      break;
    case "installing":
      tone = "busy";
      text = "설치하고 있어요. 잠시 뒤 앱이 새 버전으로 다시 켜져요";
      label = "설치 중";
      disabled = true;
      break;
    case "error":
      tone = "error";
      text = updateState.message;
      label = "다시 시도";
      break;
    default:
      if (status?.available && status.installable) {
        tone = "new";
        text = `새 버전 ${latest}이 나왔어요`;
        label = "지금 업데이트";
        primary = true;
      } else if (status?.available) {
        tone = "new";
        text = `새 버전 ${latest}이 나왔어요. ${status.reason ?? ""}`.trim();
        label = "받으러 가기";
        primary = true;
      } else if (status?.latest) {
        tone = "ok";
        text = "최신 버전을 쓰고 있어요";
      } else {
        tone = "muted";
        text = "아직 공개된 새 버전이 없어요";
      }
  }
  row.dataset.tone = tone;
  iconBox.innerHTML =
    tone === "busy"
      ? '<span class="spinner"></span>'
      : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${
          tone === "error" ? UPDATE_ICONS.alert : tone === "new" ? UPDATE_ICONS.up : UPDATE_ICONS.check
        }</svg>`;
  hint.textContent = text;
  button.textContent = label;
  button.disabled = disabled;
  button.classList.toggle("primary", primary);
  bar.hidden = updateState.phase !== "downloading";
  bar.querySelector<HTMLElement>("span")!.style.width = `${Math.round(updateState.fraction * 100)}%`;
}

function updateError(error: unknown, fallback: string): string {
  if (typeof error === "string" && error) return error;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

async function refreshUpdate(): Promise<void> {
  updateState.phase = "checking";
  paintUpdate();
  // 너무 빨리 끝나면 눌렀는지 모르니 잠깐은 "확인 중"을 보여 준다
  const [result] = await Promise.allSettled([checkForUpdate(), new Promise((resolve) => window.setTimeout(resolve, 600))]);
  if (result.status === "fulfilled") {
    updateState.status = result.value;
    updateState.phase = "idle";
    updateState.message = "";
  } else {
    updateState.phase = "error";
    updateState.message = updateError(result.reason, "업데이트를 확인하지 못했어요");
  }
  paintUpdate();
}

async function runUpdate(): Promise<void> {
  const status = updateState.status;
  if (updateState.phase !== "idle" && updateState.phase !== "error") return;
  if (updateState.phase === "error" || !status?.available) {
    await refreshUpdate();
    return;
  }
  if (!status.installable) {
    if (status.page) await openUpdatePage(status.page).catch((error) => toast(String(error)));
    return;
  }
  updateState.phase = "downloading";
  updateState.fraction = 0;
  paintUpdate();
  try {
    await installUpdate();
    updateState.phase = "installing";
    paintUpdate();
  } catch (error) {
    updateState.phase = "error";
    updateState.message = updateError(error, "설치하지 못했어요");
    paintUpdate();
  }
}

// ------------------------------------------------------------------ 일반 설정

/** 캐릭터와 상관없는 앱 설정 (자동 시작·데이터 폴더·종료). 오른쪽 패널은 캐릭터 설정만 둔다. */
function openGeneral(): void {
  const settings = state.settings;
  if (!settings || document.querySelector(".general")) return;
  const overlay = document.createElement("div");
  overlay.className = "dialog-backdrop";
  overlay.innerHTML = `
    <div class="dialog general" role="dialog" aria-modal="true" aria-label="일반 설정">
      <div class="general-head">
        <h3>일반 설정</h3>
        <button class="icon-button small" data-general="close" title="닫기 (esc)">${icon("close", 15)}</button>
      </div>
      <div class="panel">
        ${toggle("autostart", "로그인할 때 자동 시작", "컴퓨터를 켜면 캐릭터도 같이 나와요", settings.autostart)}
        <div class="panel-row update-row" id="update-row">
          <div class="update-icon"></div>
          <div class="text">
            <div class="label">업데이트 <span class="update-current">지금 v${escape(state.version)}</span></div>
            <div class="hint" id="update-hint"></div>
            <div class="update-bar" hidden><span></span></div>
          </div>
          <button class="button" data-general="update">다시 확인</button>
        </div>
        <div class="panel-row">
          <div class="text"><div class="label">데이터 폴더</div><div class="hint">설정·가져온 모델·썸네일이 들어 있어요</div></div>
          <button class="button" data-general="data">${icon("folder", 14)}열기</button>
        </div>
        <div class="panel-row">
          <div class="text"><div class="label">사용법</div><div class="hint">처음 켰을 때 본 안내를 다시 봐요</div></div>
          <button class="button" data-general="tour">다시 보기</button>
        </div>
      </div>
      <div class="general-foot">
        <span class="version">ScreenMate ${escape(state.version)}</span>
        <button class="button" data-general="quit">${icon("power", 14)}종료</button>
      </div>
    </div>`;
  const close = () => {
    window.removeEventListener("keydown", onKeyDown, true);
    overlay.classList.add("leaving");
    window.setTimeout(() => overlay.remove(), 140);
  };
  const onKeyDown = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key !== "Escape") return;
    keyEvent.preventDefault();
    keyEvent.stopPropagation();
    close();
  };
  overlay.addEventListener("click", (clickEvent) => {
    const action = (clickEvent.target as Element).closest<HTMLElement>("[data-general]")?.dataset.general;
    if (action === "close" || clickEvent.target === overlay) close();
    else if (action === "data") void openDataFolder();
    else if (action === "tour") {
      close();
      showTour();
    } else if (action === "update") void runUpdate();
    else if (action === "quit") void quitApp();
  });
  window.addEventListener("keydown", onKeyDown, true);
  document.body.append(overlay);
  paintUpdate();
  bind(overlay);
}

// ------------------------------------------------------------------ 처음 켰을 때 안내

let tour: Tour | null = null;

function showTour(): void {
  if (tour) return;
  tour = openTour({
    appIcon: appIconLarge,
    modelCount: () => state.models.length,
    heroImage: () => {
      const path = (activeModel() ?? state.models[0])?.thumbnail;
      return path ? `${mateUrl(path)}?v=${state.thumbVersion}` : null;
    },
    importModels: () => void importModels(),
    finish: () => {
      tour = null;
      if (state.settings && !state.settings.onboarded) void change({ onboarded: true });
    },
  });
}

// ------------------------------------------------------------------ 확인 창

function confirmDialog(options: { title: string; body: string; confirm: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "dialog-backdrop";
    overlay.innerHTML = `
      <div class="dialog" role="alertdialog" aria-modal="true">
        <h3>${escape(options.title)}</h3>
        <p>${escape(options.body)}</p>
        <div class="dialog-actions">
          <button class="button" data-answer="no">취소</button>
          <button class="button ${options.danger ? "destructive" : "primary"}" data-answer="yes">${escape(options.confirm)}</button>
        </div>
      </div>`;
    const finish = (answer: boolean) => {
      window.removeEventListener("keydown", onKeyDown, true);
      overlay.classList.add("leaving");
      window.setTimeout(() => overlay.remove(), 140);
      resolve(answer);
    };
    // Enter는 포커스가 있는 버튼. 지우는 확인 창은 "취소"에 포커스를 둬서 Delete→Enter로 바로 지워지지 않게 한다
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape") finish(false);
      else if (keyEvent.key === "Enter") finish((document.activeElement as HTMLElement | null)?.dataset.answer === "yes");
      else if (keyEvent.key === "Tab" || keyEvent.key === "ArrowLeft" || keyEvent.key === "ArrowRight") {
        const buttons = [...overlay.querySelectorAll<HTMLButtonElement>("[data-answer]")];
        const next = buttons.find((button) => button !== document.activeElement);
        next?.focus();
      } else return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
    };
    overlay.addEventListener("click", (clickEvent) => {
      const answer = (clickEvent.target as Element).closest<HTMLElement>("[data-answer]")?.dataset.answer;
      if (answer) finish(answer === "yes");
      else if (clickEvent.target === overlay) finish(false);
    });
    window.addEventListener("keydown", onKeyDown, true);
    document.body.append(overlay);
    overlay.querySelector<HTMLButtonElement>(`[data-answer="${options.danger ? "no" : "yes"}"]`)?.focus();
  });
}

// ------------------------------------------------------------------ 정리 (폴더·이름·삭제)

/** 가장 최근 저장 번호. 늦게 온 예전 응답이 화면을 되돌리지 않게 */
let librarySeq = 0;
let librarySaving = 0;

async function commitLibrary(next: Library, message?: string): Promise<void> {
  state.library = next;
  render();
  if (message) toast(message);
  const seq = ++librarySeq;
  librarySaving++;
  try {
    const saved = await saveLibrary(next);
    if (seq === librarySeq) state.library = saved;
  } catch (error) {
    toast("저장하지 못했어요");
    diag(`library save failed ${String(error)}`);
  } finally {
    librarySaving--;
  }
}

/** 모델·폴더를 폴더(null이면 맨 위)로 옮긴다 */
async function moveItems(payload: Payload, folderId: string | null): Promise<void> {
  const models = payload.models.filter((id) => folderOf(state.library, id) !== folderId);
  const folders = payload.folders.filter((id) => folderById(id) && (folderById(id)!.parent ?? null) !== folderId && canDropInto({ models: [], folders: [id] }, folderId));
  if (!models.length && !folders.length) return;
  let next = moveTo(state.library, models, folderId);
  for (const id of folders) next = moveFolder(next, id, folderId);
  // 지금 보는 곳에서 빠진 모델은 고른 것에서도 뺀다
  if (folderId !== state.folder) for (const id of models) state.selected.delete(id);
  const name = folderById(folderId)?.name;
  const what = folders.length && !models.length ? (folders.length === 1 ? `‘${folderById(folders[0])!.name}’ 폴더를` : `폴더 ${folders.length}개를`) : `${models.length + folders.length}개를`;
  await commitLibrary(next, name ? `${what} ‘${name}’에 넣었어요` : `${what} 맨 위로 옮겼어요`);
}

/** 지금 보는 곳(맨 위 또는 폴더 안)에 새 폴더를 만들고, 넘긴 모델·폴더를 넣은 뒤 바로 이름을 짓게 한다 */
async function newFolder(payload: Payload): Promise<void> {
  const created = createFolder(state.library, undefined, undefined, state.folder);
  let next = moveTo(created.library, payload.models, created.folder.id);
  for (const id of payload.folders) next = moveFolder(next, id, created.folder.id);
  for (const id of payload.models) state.selected.delete(id);
  state.renaming = { kind: "folder", id: created.folder.id, where: "tile" };
  const count = payload.models.length + payload.folders.length;
  await commitLibrary(next, count ? `새 폴더에 ${count}개를 넣었어요` : undefined);
}

async function removeFolder(id: string): Promise<void> {
  const folder = folderById(id);
  if (!folder) return;
  const models = modelsIn(state.library, state.models, id).length;
  const folders = childFolders(state.library, id).length;
  if (models || folders) {
    const inside = [models ? `모델 ${models}개` : "", folders ? `폴더 ${folders}개` : ""].filter(Boolean).join("와 ");
    const ok = await confirmDialog({
      title: `‘${folder.name}’ 폴더를 삭제할까요?`,
      body: `안에 있는 ${inside}는 지워지지 않고 ${folder.parent ? `‘${folderById(folder.parent)?.name}’` : "맨 위"}로 나와요.`,
      confirm: "폴더 삭제",
      danger: true,
    });
    if (!ok) return;
  }
  // 지우는 폴더(또는 그 안)를 보고 있었으면 지운 폴더의 위로 간다
  if (state.folder === id || (state.folder && folderPath(state.library, state.folder).some((step) => step.id === id))) {
    state.folder = folder.parent ?? null;
  }
  await commitLibrary(deleteFolders(state.library, [id]), `‘${folder.name}’ 폴더를 삭제했어요`);
}

async function removeModels(ids: string[]): Promise<void> {
  const models = ids.map((id) => modelById(id)).filter((model): model is ModelListing => !!model);
  if (!models.length) return;
  const includesActive = models.some((model) => model.id === state.settings?.modelId);
  const ok = await confirmDialog({
    title: models.length === 1 ? `‘${title(models[0])}’ 모델을 삭제할까요?` : `모델 ${models.length}개를 삭제할까요?`,
    body:
      "가져온 사본과 썸네일이 지워져요. 처음 가져온 원본 폴더는 그대로 있어서 다시 가져올 수 있어요." +
      (includesActive ? " 지금 쓰는 모델이 들어 있어서 다른 모델로 바뀌어요." : ""),
    confirm: "삭제",
    danger: true,
  });
  if (!ok) return;
  try {
    const removed = await deleteModels(models.map((model) => model.id));
    for (const model of models) state.selected.delete(model.id);
    if (models.some((model) => model.id === state.inspectId)) state.inspectId = null;
    toast(`모델 ${removed}개를 삭제했어요`);
  } catch (error) {
    toast("삭제하지 못했어요");
    diag(`delete failed ${String(error)}`);
  }
}

function startRename(renaming: Renaming): void {
  state.renaming = renaming;
  if (renaming.kind === "model") inspect(renaming.id);
  render();
}

/** 이름 입력칸이 있으면 포커스하고, Enter·바깥 클릭은 저장, Esc는 취소 */
function focusRename(): void {
  const input = root.querySelector<HTMLInputElement>("input.rename");
  const renaming = state.renaming;
  if (!input || !renaming) return;
  input.focus();
  input.select();
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    state.renaming = null;
    const value = input.value;
    if (!save) return render();
    if (renaming.kind === "folder") {
      const next = renameFolder(state.library, renaming.id, value);
      if (next === state.library || folderById(renaming.id)?.name === value.trim()) return render();
      void commitLibrary(next);
    } else {
      const model = modelById(renaming.id);
      if (!model) return render();
      void commitLibrary(renameModel(state.library, model, value), value.trim() ? undefined : "원래 이름으로 돌렸어요");
    }
  };
  input.addEventListener("keydown", (keyEvent) => {
    if (keyEvent.key === "Enter") finish(true);
    else if (keyEvent.key === "Escape") finish(false);
    else return;
    keyEvent.preventDefault();
    keyEvent.stopPropagation();
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("pointerdown", (pointerEvent) => pointerEvent.stopPropagation());
}

// ------------------------------------------------------------------ 입력

/** 다시 그릴 때마다 새 요소에 붙이는 것 (헤더·오른쪽 패널) */
function bind(scope: ParentNode = root): void {
  scope.querySelectorAll<HTMLButtonElement>("[data-use]").forEach((button) =>
    button.addEventListener("click", () => void use(button.dataset.use!)),
  );
  scope.querySelectorAll<HTMLElement>("[data-toggle]").forEach((row) =>
    row.addEventListener("click", () => {
      const key = row.dataset.toggle as ToggleKey;
      void change({ [key]: !state.settings?.[key] });
    }),
  );
  scope.querySelectorAll<HTMLButtonElement>("[data-sleep]").forEach((button) =>
    button.addEventListener("click", () => void change({ sleepMinutes: Number(button.dataset.sleep) })),
  );
  scope.querySelectorAll<HTMLButtonElement>("[data-size]").forEach((button) =>
    button.addEventListener("click", () => void change({ heightPx: Number(button.dataset.size) })),
  );
  const height = scope.querySelector<HTMLInputElement>("#height");
  if (height) {
    height.addEventListener("pointerdown", () => {
      slider.dragging = true;
      slider.gliding = false;
      cancelAnimationFrame(slider.frame);
    });
    height.addEventListener("input", () => {
      const value = Number(height.value);
      showHeight(value, false);
      markSizeChoice(value);
      sendHeight(value);
    });
    // 놓을 때(키보드로 바꿀 때도) 마지막 값은 바로 보낸다
    height.addEventListener("change", () => {
      slider.dragging = false;
      sendHeight(Number(height.value), true);
    });
  }
  scope.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) =>
    button.addEventListener("click", () => {
      if (button.dataset.action === "import") void importModels();
      else if (button.dataset.action === "open-models") void openModelsFolder();
      else if (button.dataset.action === "general") openGeneral();
    }),
  );
}

/** 한 번만 붙이는 것 (다시 그려도 그대로): 버튼 동작, 끌기·고르기, 오른쪽 클릭, 키보드 */
function bindOnce(): void {
  root.addEventListener("click", (event) => {
    const target = event.target as Element;
    const nav = target.closest<HTMLElement>("[data-nav]");
    if (nav) return openFolder(nav.dataset.nav || null);
    const action = target.closest<HTMLElement>("[data-act]");
    if (!action) return;
    const rect = action.getBoundingClientRect();
    lastMenuPoint = { x: rect.left, y: rect.top - 8 };
    const inspected = modelById(state.inspectId) ?? activeModel();
    switch (action.dataset.act) {
      case "new-folder":
        return void newFolder({ models: [], folders: [] });
      case "move-selection":
        return chooseFolder({ models: [...state.selected], folders: [] }, { x: rect.left, y: rect.top - 220 });
      case "delete-selection":
        return void removeModels([...state.selected]);
      case "clear-selection":
        return clearSelection();
      case "rename-inspected":
        if (inspected) startRename({ kind: "model", id: inspected.id, where: "inspector" });
        return;
      case "delete-inspected":
        if (inspected) void removeModels([inspected.id]);
        return;
    }
  });
  root.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("contextmenu", onContextMenu);
  window.addEventListener("contextmenu", (event) => (lastMenuPoint = { x: event.clientX, y: event.clientY }), true);
  window.addEventListener("keydown", onKey);
  window.addEventListener("blur", closeMenu);
  window.addEventListener("resize", closeMenu);
}

/** 폴더를 연다 (null이면 맨 위). 오른쪽에는 그 폴더에서 쓰는 중인 모델, 없으면 첫 모델을 보여 준다 */
function openFolder(id: string | null): void {
  if (state.folder === id) return;
  state.folder = id;
  state.renaming = null;
  // 끌던 모델은 그대로 고른 채로 둔다 (다른 폴더에 놓을 수 있게)
  if (!document.body.classList.contains("dragging")) state.selected.clear();
  const models = visibleModels();
  const using = models.find((model) => model.id === state.settings?.modelId);
  const first = using ?? models[0];
  if (first && !document.body.classList.contains("dragging")) {
    state.inspectId = first.id;
    state.selected = new Set([first.id]);
    state.anchor = first.id;
  }
  render();
}

/**
 * esc: 메뉴 닫기 → 여러 개 고른 것 풀기 → 한 단계 위 폴더로, ←→: 모델 고르기, return: 고른 모델 쓰기,
 * Delete·Backspace: 고른 모델 삭제, F2: 이름 바꾸기, ⌘A: 전부 고르기
 */
function onKey(event: KeyboardEvent): void {
  if (event.target instanceof HTMLInputElement || document.querySelector(".dialog")) return;
  if (event.key === "Escape" && document.querySelector(".menu")) {
    closeMenu();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
    event.preventDefault();
    selectAll();
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === "Escape") {
    if (state.selected.size > 1 && state.inspectId) selectOnly(state.inspectId);
    else if (state.folder) openFolder(folderById(state.folder)?.parent ?? null);
    return;
  }
  if ((event.key === "Delete" || event.key === "Backspace") && state.selected.size) {
    event.preventDefault();
    void removeModels([...state.selected]);
    return;
  }
  const current = state.inspectId ?? state.settings?.modelId ?? null;
  if (event.key === "F2" && current) {
    event.preventDefault();
    const onScreen = root.querySelector(`.content [data-model="${CSS.escape(current)}"]`);
    startRename({ kind: "model", id: current, where: onScreen ? "tile" : "inspector" });
    return;
  }
  const models = visibleModels();
  if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && models.length) {
    event.preventDefault();
    const index = models.findIndex((model) => model.id === current);
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = models[(index + step + models.length) % models.length];
    selectOnly(next.id);
    root.querySelector(`[data-model="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter" && current && current !== state.settings?.modelId) {
    event.preventDefault();
    void use(current);
  }
}

async function use(id: string): Promise<void> {
  state.settings = await selectModel(id);
  state.inspectId = id;
  render();
  toast("모델을 바꿨어요");
}

type ToggleKey = "gaze" | "variety" | "ledges" | "autostart";

/** 가장 최근 요청 번호. 늦게 온 예전 응답이 화면을 되돌리지 않게 */
let changeSeq = 0;
/** 아직 응답이 안 온 요청 수 */
let pendingChanges = 0;

/**
 * 설정을 바꾼다. 화면은 먼저 바꿔 두고(토글 트랜지션이 바로 돈다) 저장 결과로 맞춘다.
 * 통째로 다시 그리지 않아서 스크롤·슬라이더 손잡이가 그대로 있다.
 */
async function change(patch: Partial<Omit<Settings, "modelId">>): Promise<void> {
  if (!state.settings) return;
  const seq = ++changeSeq;
  state.settings = { ...state.settings, ...patch };
  syncSettings();
  pendingChanges++;
  const saved = await updateSettings(patch).finally(() => pendingChanges--);
  if (seq !== changeSeq) return;
  state.settings = saved;
  syncSettings();
}

/** 설정 패널의 토글·선택·슬라이더를 지금 설정에 맞춘다 (요소는 그대로 두고 상태만) */
function syncSettings(): void {
  const settings = state.settings;
  if (!settings) return;
  document.querySelectorAll<HTMLElement>("[data-toggle]").forEach((row) => {
    const on = settings[row.dataset.toggle as ToggleKey];
    const button = row.querySelector(".switch");
    button?.classList.toggle("on", on);
    button?.setAttribute("aria-checked", String(on));
  });
  root.querySelectorAll<HTMLButtonElement>("[data-sleep]").forEach((button) =>
    button.classList.toggle("active", settings.sleepMinutes === Number(button.dataset.sleep)),
  );
  if (!slider.dragging) {
    markSizeChoice(settings.heightPx);
    glideHeight(settings.heightPx);
  }
}

const slider = { dragging: false, lastSent: 0, timer: 0, frame: 0, gliding: false, target: 0 };
/** 작게·보통·크게를 눌렀을 때 손잡이가 미끄러지는 시간 (ms) */
const GLIDE_MS = 260;

/** 손잡이를 지금 자리에서 value까지 부드럽게 옮긴다 (range input 값은 CSS로 트랜지션이 안 된다) */
function glideHeight(value: number): void {
  const input = root.querySelector<HTMLInputElement>("#height");
  if (!input) return;
  if (slider.gliding && Math.abs(slider.target - value) < 0.5) return;
  cancelAnimationFrame(slider.frame);
  slider.gliding = false;
  const from = Number(input.value);
  if (Math.abs(from - value) < 0.5) {
    showHeight(value, true);
    return;
  }
  slider.gliding = true;
  slider.target = value;
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min((now - start) / GLIDE_MS, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    showHeight(from + (value - from) * eased, true);
    if (t < 1) slider.frame = requestAnimationFrame(step);
    else slider.gliding = false;
  };
  slider.frame = requestAnimationFrame(step);
}

/** 슬라이더 숫자·채운 부분 (moveThumb: 손잡이도 옮긴다. 끄는 중엔 손잡이를 건드리지 않는다) */
function showHeight(value: number, moveThumb: boolean): void {
  const input = root.querySelector<HTMLInputElement>("#height");
  if (!input) return;
  if (moveThumb) input.value = String(value);
  input.style.setProperty("--fill", fillOf(value));
  root.querySelector("#height-value")!.textContent = `${Math.round(value)}px`;
}

function markSizeChoice(value: number): void {
  root.querySelectorAll<HTMLButtonElement>("[data-size]").forEach((button) =>
    button.classList.toggle("active", Math.abs(value - Number(button.dataset.size)) < 0.5),
  );
}

function fillOf(value: number): string {
  return `${(((value - HEIGHT_MIN) / (HEIGHT_MAX - HEIGHT_MIN)) * 100).toFixed(2)}%`;
}

/** 끄는 동안 화면 캐릭터 크기를 일정 간격으로 따라 바꾼다. now면 기다리지 않고 보낸다 */
function sendHeight(value: number, now = false): void {
  window.clearTimeout(slider.timer);
  const send = () => {
    slider.lastSent = performance.now();
    void change({ heightPx: value });
  };
  const wait = HEIGHT_SEND_INTERVAL - (performance.now() - slider.lastSent);
  if (now || wait <= 0) send();
  else slider.timer = window.setTimeout(send, wait);
}

// ------------------------------------------------------------------ 시작

/** 처음 정리하거나 새로 들어온 모델을 폴더에 넣고, 바뀌었으면 저장한다 */
function organizeLibrary(): void {
  const { library, changed } = organize(state.library, state.models);
  if (!changed) return;
  state.library = library;
  void saveLibrary(library).catch((error) => diag(`library save failed ${String(error)}`));
}

async function refreshModels(): Promise<void> {
  state.models = await listModels();
  state.thumbVersion = Date.now();
  organizeLibrary();
  const ids = new Set(state.models.map((model) => model.id));
  state.selected = new Set([...state.selected].filter((id) => ids.has(id)));
  if (state.renaming?.kind === "model" && !ids.has(state.renaming.id)) state.renaming = null;
  if (!state.renaming) render();
  tour?.refresh();
  ensureThumbnails();
}

/** 썸네일이 없는 모델은 이 창에서 찍는다 (화면 위 캐릭터는 그대로). 하나 저장할 때마다 Rust가 models-changed를 보낸다 */
function ensureThumbnails(): void {
  if (!state.models.some(needsThumbnail)) return;
  void makeMissingThumbnails(state.models, (done, total) => {
    state.progress = done < total ? { done, total } : null;
    if (!state.renaming && !document.body.classList.contains("dragging")) render();
  }).catch((error) => {
    state.progress = null;
    diag(`thumbnails crashed ${String(error)}`);
  });
}

async function start(): Promise<void> {
  const [settings, models, library, version] = await Promise.all([
    getSettings(),
    listModels(),
    getLibrary(),
    getVersion().catch(() => ""),
  ]);
  state.settings = settings;
  state.models = models;
  state.library = library;
  state.version = version;
  organizeLibrary();
  // 쓰는 중인 모델이 든 폴더를 열고 그 모델을 골라 둔다
  const active = activeModel();
  if (active) {
    state.folder = folderOf(state.library, active.id);
    state.inspectId = active.id;
    state.selected = new Set([active.id]);
    state.anchor = active.id;
  }
  bindOnce();
  render();
  if (!settings.onboarded) showTour();
  void onUpdateProgress((progress) => {
    if (updateState.phase !== "downloading" && updateState.phase !== "installing") return;
    updateState.phase = progress.phase === "install" ? "installing" : "downloading";
    updateState.fraction = progress.fraction;
    paintUpdate();
  });
  void refreshUpdate();
  // 트레이 등 다른 곳에서 바꾼 설정. 모델이 바뀌면 카드 배지까지 다시 그리고, 아니면 패널만 맞춘다.
  // 이 창이 보낸 요청이 아직 안 끝났으면 그 응답을 기다린다 (예전 값으로 튀지 않게).
  void onSettingsChanged((next) => {
    const modelChanged = next.modelId !== state.settings?.modelId;
    if (!modelChanged && (slider.dragging || pendingChanges > 0)) return;
    state.settings = next;
    if (modelChanged && !state.renaming) render();
    else syncSettings();
  });
  // 모델을 지웠을 때 Rust가 정리한 결과 (이 창이 저장 중이면 그 결과를 기다린다)
  void onLibraryChanged((next) => {
    if (librarySaving > 0) return;
    state.library = next;
    if (!state.renaming && !document.body.classList.contains("dragging")) render();
  });
  window.addEventListener("pointerup", () => {
    slider.dragging = false;
  });
  void onModelsChanged(() => void refreshModels());
  ensureThumbnails();
}

// Tauri IPC가 주입되기 전에 시작하면 invoke가 실패한다.
const ready = () => (window as Window & { __TAURI_INTERNALS__?: { metadata?: unknown } }).__TAURI_INTERNALS__?.metadata != null;
if (ready()) {
  void start();
} else {
  const timer = window.setInterval(() => {
    if (ready()) {
      window.clearInterval(timer);
      void start();
    }
  }, 50);
}
