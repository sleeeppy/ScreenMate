import type { Engine } from "@babylonjs/core/Engines/engine";
import { invoke } from "@tauri-apps/api/core";
import type { CssRect } from "../ipc";
import type { FollowBox } from "./followBox";

const HIT_ALPHA = 8;
const MISS_FRAMES = 2;
/**
 * 커서 주변 이만큼(CSS px, 한 변)의 픽셀 중 가장 진한 알파로 판정한다.
 * 한 픽셀만 보면 셔츠 끝·팔과 몸 사이 틈·반투명 천에 걸려 클릭이 뒤 창으로 통과된다.
 */
const PROBE_CSS = 6;

/**
 * 커서 아래 픽셀의 알파값으로 캐릭터 위인지 판정하고 클릭 통과를 켜고 끈다.
 * 기본은 통과(아래 창이 클릭을 받음). 캐릭터 픽셀 위에서만 입력을 받는다.
 */
export class HitTester {
  private ignoring = true;
  private pressed = false;
  private misses = 0;
  private pending = false;
  /** 빠른 메뉴 자리 (CSS px): 캐릭터 픽셀처럼 입력을 받는다. "screen"이면 화면 전체 */
  private held: CssRect | "screen" | null = null;
  private lastCursor: { x: number; y: number } | null = null;

  constructor(
    private readonly engine: Engine,
    private readonly canvas: HTMLCanvasElement,
    private readonly box: FollowBox,
  ) {
    // 끄는 동안만 입력을 붙잡는다 (왼쪽 버튼). 우클릭은 메뉴가 떠서 pointerup이 안 올 수 있어 세지 않는다.
    window.addEventListener("pointerdown", (event) => {
      if (event.button === 0) this.pressed = true;
    });
    window.addEventListener("pointermove", (event) => {
      // 창 밖에서 버튼을 떼 pointerup을 놓쳤으면 즉시 푼다
      if (this.pressed && (event.buttons & 1) === 0) this.pressed = false;
    });
    const release = () => {
      this.pressed = false;
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
  }

  get capturing(): boolean {
    return !this.ignoring;
  }

  /** scene.render() 직후에 호출한다 (같은 프레임 버퍼를 읽어야 함). */
  sample(cursor: { x: number; y: number } | null): void {
    this.lastCursor = cursor;
    if (this.pressed || this.pending || this.held === "screen") {
      return;
    }
    if (cursor && this.held && contains(this.held, cursor)) {
      this.misses = 0;
      this.setIgnoring(false);
      return;
    }
    if (!cursor || !this.box.contains(cursor.x, cursor.y)) {
      this.noteMiss();
      return;
    }
    const { rect } = this.box;
    const ratioX = this.canvas.width / Math.max(1, rect.width);
    const ratioY = this.canvas.height / Math.max(1, rect.height);
    const size = Math.max(1, Math.round(PROBE_CSS * ratioX));
    const half = Math.floor(size / 2);
    const x = clamp(Math.floor((cursor.x - rect.x) * ratioX) - half, 0, this.canvas.width - size);
    const yFromTop = Math.floor((cursor.y - rect.y) * ratioY);
    const y = clamp(this.canvas.height - 1 - yFromTop - half, 0, this.canvas.height - size);

    this.pending = true;
    void this.engine
      .readPixels(x, y, size, size, true, true)
      .then((buffer) => {
        this.pending = false;
        // 비동기 readPixels 완료 사이에 메뉴가 열렸거나 커서가 메뉴 위로 갔으면 결과를 무시한다
        if (this.held === "screen" || (this.held && this.lastCursor && contains(this.held, this.lastCursor))) {
          return;
        }
        if (maxAlpha(buffer) > HIT_ALPHA) {
          this.misses = 0;
          this.setIgnoring(false);
        } else {
          this.noteMiss();
        }
      })
      .catch(() => {
        this.pending = false;
      });
  }

  /**
   * 빠른 메뉴가 열려 있는 동안 그 자리에서도 입력을 받는다 (나머지는 평소처럼 캐릭터 픽셀만).
   * "screen"이면 화면 전체를 붙잡는다. null이면 다음 판정부터 평소대로.
   */
  hold(area: CssRect | "screen" | null): void {
    this.held = area;
    if (area) {
      this.misses = 0;
      this.setIgnoring(false);
    }
  }

  /** 모델 교체·전체화면 숨김 등으로 캐릭터가 사라졌을 때 */
  release(): void {
    this.pressed = false;
    this.held = null;
    this.misses = MISS_FRAMES;
    this.setIgnoring(true);
  }

  private noteMiss(): void {
    if (this.pressed || this.held === "screen") {
      return;
    }
    this.misses += 1;
    if (this.misses >= MISS_FRAMES) {
      this.setIgnoring(true);
    }
  }

  private setIgnoring(next: boolean): void {
    if (next === this.ignoring) {
      return;
    }
    this.ignoring = next;
    // Rust 쪽에서 전환 후 창 스타일(포커스 안 뺏기·Alt+Tab 숨김)을 다시 붙인다.
    void invoke("set_click_through", { ignore: next });
  }
}

function contains(rect: CssRect, point: { x: number; y: number }): boolean {
  return point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height;
}

function clamp(value: number, min: number, max: number): number {
  return max < min ? min : Math.min(max, Math.max(min, value));
}

function maxAlpha(buffer: ArrayBufferView): number {
  const bytes =
    buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let max = 0;
  for (let index = 3; index < bytes.length; index += 4) {
    if (bytes[index] > max) max = bytes[index];
  }
  return max;
}
