/**
 * 캐릭터 우클릭 빠른 메뉴: 앱(설정 창) 열기와 자주 바꾸는 설정 몇 개.
 *
 * 설정 창의 오른쪽 클릭 메뉴(.menu)처럼 작고 단순하게: 앱 열기, 스위치 셋, 크기, 종료.
 * 오버레이 창은 평소 캐릭터 픽셀 위에서만 입력을 받으므로, 열려 있는 동안은 메뉴 자리에서도 입력을 받는다(capture).
 * 그 밖을 누르면 메뉴가 닫히고 클릭은 그대로 아래 창으로 간다. 클릭 통과 중이라 웹뷰는 그 클릭을 못 받으므로
 * 마우스 버튼 상태를 Rust에서 읽어 알아챈다. 버튼 상태를 알 수 없는 플랫폼이면 예전처럼 화면 전체를 붙잡는다.
 */
import {
  getSettings,
  mousePressed,
  onSettingsChanged,
  openSettingsWindow,
  quitApp,
  updateSettings,
  type CssRect,
  type Settings,
} from "../ipc";
import "./quickMenu.css";

export interface QuickMenuHost {
  /** 열려 있는 동안 이 자리(또는 화면 전체)에서도 입력을 받는다. null이면 평소대로 */
  capture(area: CssRect | "screen" | null): void;
  /** 지금 오버레이가 커서 아래 입력을 받고 있는지 (메뉴·캐릭터 위) */
  readonly capturing: boolean;
}

type ToggleKey = "gaze" | "variety" | "ledges";

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICON_OPEN = svg('<path d="M14 5h5v5M19 5l-8 8"/><path d="M17 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4"/>');

const TOGGLES: readonly { key: ToggleKey; label: string }[] = [
  { key: "gaze", label: "커서 바라보기" },
  { key: "variety", label: "다양한 동작" },
  { key: "ledges", label: "창 위에 올라가기" },
];
/** 설정 창 크기 단계와 같게 (settings/main.ts SIZES) */
const SIZES: readonly { label: string; value: number }[] = [
  { label: "작게", value: 200 },
  { label: "보통", value: 260 },
  { label: "크게", value: 340 },
];
/** 커서에서 띄우는 거리·화면 끝 여백 (px) */
const GAP = 8;
const MARGIN = 12;
const CLOSE_MS = 130;
/** 메뉴 밖 클릭을 알아채려고 마우스 버튼을 읽는 간격 (ms) */
const PRESS_POLL_MS = 30;

export class QuickMenu {
  private element: HTMLElement | null = null;
  private settings: Settings | null = null;
  private closing: number | null = null;
  private watching: number | null = null;

  constructor(private readonly host: QuickMenuHost) {
    void onSettingsChanged((next) => {
      this.settings = next;
      if (this.element) this.sync();
    });
    // 메뉴 밖을 누르면 닫는다. 캐릭터를 잡거나 클릭으로 치지 않게 가장 먼저(캡처 단계에서) 막는다.
    const outside = (event: Event) => {
      if (!this.element || this.closing !== null) return;
      if (event.target instanceof Node && this.element.contains(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === "pointerdown") this.close();
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("contextmenu", outside, true);
  }

  get isOpen(): boolean {
    return this.element !== null && this.closing === null;
  }

  async open(point: { x: number; y: number }): Promise<void> {
    this.removeNow();
    this.host.capture("screen");
    try {
      this.settings = await getSettings();
    } catch {
      this.settings = null;
    }
    const element = document.createElement("div");
    element.className = "qm";
    element.setAttribute("role", "menu");
    element.innerHTML = `
      <button class="qm-row qm-open" data-qm="open" role="menuitem">
        <span class="qm-label">ScreenMate 열기</span>${ICON_OPEN}
      </button>
      <div class="qm-sep"></div>
      ${TOGGLES.map(
        (toggle) => `
        <button class="qm-row" data-qm="${toggle.key}" role="menuitemcheckbox">
          <span class="qm-label">${toggle.label}</span>
          <span class="qm-switch" aria-hidden="true"></span>
        </button>`,
      ).join("")}
      <div class="qm-row qm-size-row" role="group" aria-label="크기">
        <span class="qm-label">크기</span>
        <span class="qm-choices">
          <span class="qm-thumb" aria-hidden="true"></span>
          ${SIZES.map((size) => `<button data-qm-size="${size.value}" role="menuitemradio">${size.label}</button>`).join("")}
        </span>
      </div>
      <div class="qm-sep"></div>
      <button class="qm-row qm-quit" data-qm="quit" role="menuitem"><span class="qm-label">종료</span></button>`;
    document.body.append(element);
    this.element = element;
    this.sync(false);
    this.place(element, point);
    element.addEventListener("click", (event) => this.onClick(event));
    void this.watchOutside(element);
  }

  /** 메뉴 자리만 붙잡고, 오버레이 밖(클릭 통과 중) 버튼이 새로 눌리면 닫는다 */
  private async watchOutside(element: HTMLElement): Promise<void> {
    let was = await mousePressed().catch(() => null);
    if (was === null || this.element !== element) return;
    // 펼쳐지는 애니메이션(transform)과 상관없는 레이아웃 자리
    this.host.capture({
      x: element.offsetLeft,
      y: element.offsetTop,
      width: element.offsetWidth,
      height: element.offsetHeight,
    });
    const tick = async () => {
      this.watching = null;
      if (this.element !== element || this.closing !== null) return;
      const down = (await mousePressed().catch(() => false)) ?? false;
      if (this.element !== element || this.closing !== null) return;
      // 오버레이 위(메뉴·캐릭터)를 누른 건 웹뷰가 직접 받는다
      if (down && !was && !this.host.capturing) {
        this.close();
        return;
      }
      was = down;
      this.watching = window.setTimeout(tick, PRESS_POLL_MS);
    };
    this.watching = window.setTimeout(tick, PRESS_POLL_MS);
  }

  close(): void {
    const element = this.element;
    if (!element || this.closing !== null) return;
    element.classList.remove("qm-in");
    element.classList.add("qm-out");
    this.closing = window.setTimeout(() => this.removeNow(), CLOSE_MS);
  }

  private removeNow(): void {
    if (this.closing !== null) window.clearTimeout(this.closing);
    this.closing = null;
    if (this.watching !== null) window.clearTimeout(this.watching);
    this.watching = null;
    if (!this.element) return;
    this.element.remove();
    this.element = null;
    this.host.capture(null);
  }

  /** 커서 오른쪽 아래에 띄우고, 화면 끝에 닿으면 반대쪽으로. 펼쳐지는 기준점도 커서 쪽 모서리. */
  private place(element: HTMLElement, point: { x: number; y: number }): void {
    const { width, height } = element.getBoundingClientRect();
    const right = point.x + GAP + width <= innerWidth - MARGIN;
    const down = point.y + GAP + height <= innerHeight - MARGIN;
    const x = right ? point.x + GAP : Math.max(MARGIN, point.x - GAP - width);
    const y = down ? point.y + GAP : Math.max(MARGIN, point.y - GAP - height);
    element.style.left = `${x}px`;
    element.style.top = `${y}px`;
    element.style.transformOrigin = `${right ? "0" : "100%"} ${down ? "0" : "100%"}`;
    element.classList.add("qm-in");
  }

  /** 스위치·크기 표시를 지금 설정에 맞춘다. animate가 false면 크기 표시가 미끄러지지 않고 바로 놓인다. */
  private sync(animate = true): void {
    const element = this.element;
    const settings = this.settings;
    if (!element || !settings) return;
    for (const toggle of TOGGLES) {
      const button = element.querySelector<HTMLElement>(`[data-qm="${toggle.key}"]`);
      button?.classList.toggle("on", settings[toggle.key]);
      button?.setAttribute("aria-checked", String(settings[toggle.key]));
    }
    const buttons = [...element.querySelectorAll<HTMLElement>("[data-qm-size]")];
    const index = buttons.findIndex((button) => Math.abs(Number(button.dataset.qmSize) - settings.heightPx) < 0.5);
    buttons.forEach((button, i) => {
      button.classList.toggle("on", i === index);
      button.setAttribute("aria-checked", String(i === index));
    });
    // 고른 크기 뒤의 둥근 판이 그 버튼으로 미끄러진다 (슬라이더로 맞춘 크기면 숨김)
    const thumb = element.querySelector<HTMLElement>(".qm-thumb");
    if (thumb) {
      const target = buttons[index];
      thumb.classList.toggle("still", !animate);
      thumb.style.opacity = target ? "1" : "0";
      if (target) {
        thumb.style.width = `${target.offsetWidth}px`;
        thumb.style.transform = `translateX(${target.offsetLeft - 2}px)`;
      }
    }
  }

  private onClick(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    const size = target?.closest<HTMLElement>("[data-qm-size]");
    if (size && this.settings) {
      this.settings = { ...this.settings, heightPx: Number(size.dataset.qmSize) };
      this.sync();
      void updateSettings({ heightPx: this.settings.heightPx });
      return;
    }
    const action = target?.closest<HTMLElement>("[data-qm]")?.dataset.qm;
    if (!action) return;
    if (action === "open") {
      void openSettingsWindow();
      this.close();
    } else if (action === "quit") {
      void quitApp();
    } else if (this.settings && (action === "gaze" || action === "variety" || action === "ledges")) {
      // 바로 스위치를 바꾸고 설정은 Rust로 보낸다. 확정 값은 settings-changed로 다시 온다.
      this.settings = { ...this.settings, [action]: !this.settings[action] };
      this.sync();
      void updateSettings({ [action]: this.settings[action] });
    }
  }
}
