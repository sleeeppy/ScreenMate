/**
 * 처음 켰을 때 보여 주는 안내 (설정 창 위에 뜨는 4장짜리 카드).
 *
 * 1. 환영  2. 모델 가져오기 (여기서 바로 가져온다)  3. 잡기·쓰다듬기·찌르기  4. 우클릭 빠른 메뉴와 이 창을 다시 여는 법
 * 끝까지 보거나 건너뛰면 다시 뜨지 않는다 (일반 설정 → 사용법 다시 보기로 다시 볼 수 있다).
 * 그림은 지금 쓰는 모델의 전신 썸네일과 실제 빠른 메뉴를 본뜬 모양으로 그린다.
 */

export interface TourHost {
  appIcon: string;
  /** 보관함에 있는 모델 수 */
  modelCount(): number;
  /** 지금 쓰는 모델의 전신 썸네일 주소 (없으면 null) */
  heroImage(): string | null;
  importModels(): void;
  /** 끝까지 봤거나 건너뛰었다 */
  finish(): void;
}

export interface Tour {
  /** 모델을 가져왔을 때 (모델 수·그림을 다시 그린다) */
  refresh(): void;
}

const svg = (body: string, size = 18) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICON = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5.5 12.5 4 4 9-9"/>',
  hand: '<path d="M8 11V6.5a1.5 1.5 0 0 1 3 0V11M11 10V5a1.5 1.5 0 0 1 3 0v5M14 10.5V7a1.5 1.5 0 0 1 3 0v6.5c0 3.6-2.4 6.5-6 6.5-2.4 0-3.9-1-5.2-3l-2.1-3.3a1.5 1.5 0 0 1 2.5-1.6L8 13.5"/>',
  heart: '<path d="M12 19s-7-4.4-7-9.3A3.7 3.7 0 0 1 12 7.6a3.7 3.7 0 0 1 7 2.1C19 14.6 12 19 12 19z"/>',
  poke: '<path d="M12 4v3M5.6 6.6l2.1 2.1M18.4 6.6l-2.1 2.1M4 13h3M17 13h3"/><circle cx="12" cy="14" r="3"/>',
  open: '<path d="M14 5h5v5M19 5l-8 8"/><path d="M17 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  cube: '<path d="M12 3.5 19.5 7.7v8.6L12 20.5 4.5 16.3V7.7z"/><path d="M4.5 7.7 12 12l7.5-4.3M12 12v8.5"/>',
};

const STEPS = 4;
const windows = () => document.documentElement.classList.contains("windows");

export function openTour(host: TourHost): Tour {
  let step = 0;
  const overlay = document.createElement("div");
  overlay.className = "dialog-backdrop tour-backdrop";
  overlay.innerHTML = `
    <div class="dialog tour" role="dialog" aria-modal="true" aria-label="ScreenMate 사용법">
      <button class="tour-skip" data-tour="skip">건너뛰기</button>
      <div class="tour-stage"></div>
      <div class="tour-body"></div>
      <div class="tour-foot">
        <div class="tour-dots">${Array.from({ length: STEPS }, (_, i) => `<span data-dot="${i}"></span>`).join("")}</div>
        <div class="tour-nav">
          <button class="button" data-tour="back">이전</button>
          <button class="button primary" data-tour="next">다음</button>
        </div>
      </div>
    </div>`;
  const stage = overlay.querySelector<HTMLElement>(".tour-stage")!;
  const body = overlay.querySelector<HTMLElement>(".tour-body")!;

  const hero = (extra = "") => {
    const image = host.heroImage();
    return image
      ? `<img class="tour-hero ${extra}" src="${image}" alt="" draggable="false" />`
      : `<div class="tour-hero tour-hero-empty ${extra}">${svg(ICON.cube, 54)}</div>`;
  };

  const scenes: (() => { stage: string; body: string })[] = [
    () => ({
      stage: `
        <div class="tour-welcome">
          <span class="tour-ring"></span><span class="tour-ring r2"></span>
          <img class="tour-icon" src="${host.appIcon}" alt="" draggable="false" />
          ${[0, 1, 2, 3, 4].map((i) => `<span class="tour-spark s${i}"></span>`).join("")}
        </div>`,
      body: `
        <h3>ScreenMate에 오신 걸 환영해요</h3>
        <p>좋아하는 MMD 캐릭터가 바탕화면 위를 걸어 다녀요. 창 위로 폴짝 뛰어올라 걸터앉고, 가만히 두면 꾸벅꾸벅 졸기도 해요.</p>`,
    }),
    () => {
      const count = host.modelCount();
      return {
        stage: `
          <div class="tour-import">
            <div class="tour-folder">${svg(ICON.folder, 124)}</div>
            <div class="tour-file f1">.pmx</div>
            <div class="tour-file f2">.pmd</div>
          </div>`,
        body: `
          <h3>먼저 모델을 데려와요</h3>
          <p>가지고 있는 MMD 모델 폴더(<code>.pmx</code>·<code>.pmd</code>)를 고르면 보관함에 들어와요. 변환할 필요 없고, 폴더 안 모델이 한 번에 들어와요.</p>
          ${
            count > 0
              ? `<div class="tour-status">${svg(ICON.check, 16)}보관함에 모델이 ${count}개 있어요</div>
                 <button class="button tour-inline" data-tour="import">${svg(ICON.plus, 14)}더 가져오기</button>`
              : `<button class="button primary tour-inline" data-tour="import">${svg(ICON.plus, 14)}모델 가져오기</button>`
          }`,
      };
    },
    () => ({
      stage: `
        <div class="tour-touch">
          ${hero()}
          <span class="tour-cursor">${svg(ICON.hand, 36)}</span>
          <span class="tour-heart h1">${svg(ICON.heart, 16)}</span>
          <span class="tour-heart h2">${svg(ICON.heart, 12)}</span>
        </div>`,
      body: `
        <h3>잡고, 던지고, 쓰다듬어요</h3>
        <ul class="tour-list">
          <li>${svg(ICON.hand, 16)}<span><b>끌어서 놓으면</b> 옮기거나 던질 수 있어요. 창 테두리 근처에 놓으면 걸터앉아요</span></li>
          <li>${svg(ICON.heart, 16)}<span><b>머리를 누르면</b> 쓰다듬기</span></li>
          <li>${svg(ICON.poke, 16)}<span><b>몸을 누르면</b> 콕 찌르기</span></li>
        </ul>`,
    }),
    () => ({
      stage: `
        <div class="tour-menu">
          ${hero("small")}
          <div class="tour-qm" aria-hidden="true">
            <div class="row open">ScreenMate 열기${svg(ICON.open, 13)}</div>
            <div class="sep"></div>
            <div class="row">커서 바라보기<span class="sw on"></span></div>
            <div class="row">다양한 동작<span class="sw on"></span></div>
            <div class="row">창 위에 올라가기<span class="sw on"></span></div>
            <div class="row">크기<span class="sizes"><i>작게</i><i class="on">보통</i><i>크게</i></span></div>
            <div class="sep"></div>
            <div class="row quit">종료</div>
          </div>
        </div>`,
      body: `
        <h3>오른쪽 클릭하면 빠른 메뉴</h3>
        <p>캐릭터를 <b>오른쪽 클릭</b>하면 바로 옆에 메뉴가 열려요. 크기나 동작을 바꾸고, <b>ScreenMate 열기</b>로 이 창을 언제든 다시 열 수 있어요.</p>
        <p class="tour-note">캐릭터가 안 보일 땐 ${windows() ? "시작 메뉴에서 ScreenMate를 다시 실행하면" : "Dock 아이콘을 누르거나 앱을 다시 실행하면"} 이 창이 열려요.</p>`,
    }),
  ];

  const paint = (direction = 0) => {
    const scene = scenes[step]();
    stage.innerHTML = scene.stage;
    body.innerHTML = scene.body;
    for (const element of [stage, body]) {
      element.classList.remove("from-right", "from-left");
      if (direction) {
        void element.offsetWidth;
        element.classList.add(direction > 0 ? "from-right" : "from-left");
      }
    }
    overlay.querySelectorAll<HTMLElement>("[data-dot]").forEach((dot) => {
      dot.classList.toggle("on", Number(dot.dataset.dot) === step);
    });
    const back = overlay.querySelector<HTMLButtonElement>('[data-tour="back"]')!;
    const next = overlay.querySelector<HTMLButtonElement>('[data-tour="next"]')!;
    back.style.visibility = step === 0 ? "hidden" : "visible";
    next.textContent = step === STEPS - 1 ? "시작하기" : "다음";
    overlay.querySelector<HTMLElement>(".tour-skip")!.style.visibility = step === STEPS - 1 ? "hidden" : "visible";
  };

  const go = (to: number) => {
    if (to < 0 || to >= STEPS || to === step) return;
    const direction = to > step ? 1 : -1;
    step = to;
    paint(direction);
  };

  const close = () => {
    window.removeEventListener("keydown", onKeyDown, true);
    overlay.classList.add("leaving");
    window.setTimeout(() => overlay.remove(), 160);
    host.finish();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
    else if (event.key === "ArrowRight" || event.key === "Enter") {
      if (step === STEPS - 1) close();
      else go(step + 1);
    } else if (event.key === "ArrowLeft") go(step - 1);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  overlay.addEventListener("click", (event) => {
    const action = (event.target as Element).closest<HTMLElement>("[data-tour]")?.dataset.tour;
    const dot = (event.target as Element).closest<HTMLElement>("[data-dot]")?.dataset.dot;
    if (dot !== undefined) go(Number(dot));
    else if (action === "skip") close();
    else if (action === "back") go(step - 1);
    else if (action === "next") step === STEPS - 1 ? close() : go(step + 1);
    else if (action === "import") host.importModels();
  });
  window.addEventListener("keydown", onKeyDown, true);
  document.body.append(overlay);
  paint();
  overlay.querySelector<HTMLButtonElement>('[data-tour="next"]')?.focus();

  return {
    refresh() {
      if (overlay.isConnected) paint();
    },
  };
}
