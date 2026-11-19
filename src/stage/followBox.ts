import { setInterestRect, type CssRect } from "../ipc";

/**
 * 캐릭터를 따라다니는 작은 캔버스.
 *
 * 화면 전체 크기 캔버스(2560×1440 + MSAA)는 GPU 메모리와 합성 비용이 크다.
 * 캐릭터 주변 상자만큼만 캔버스를 만들고 CSS transform으로 옮긴다.
 * transform은 같은 합성 프레임에 반영되므로 카메라 이동과 어긋나지 않는다.
 * 캔버스 크기는 캐릭터 키가 바뀔 때만 바꾼다 (WebGL 버퍼 재할당을 피함).
 */
export interface BoxShape {
  /** 상자 너비 / 캐릭터 키 */
  widthRatio: number;
  /** 상자 높이 / 캐릭터 키 */
  heightRatio: number;
  /** 발 아래 여백 / 캐릭터 키 */
  footPadRatio: number;
}

export const STANDING_BOX: BoxShape = { widthRatio: 1.35, heightRatio: 1.5, footPadRatio: 0.06 };

/** 관심 영역 = 상자 + 이 여백. 이 안에서만 Rust가 커서 위치를 보낸다 (시선 추적 범위). */
const INTEREST_MARGIN = 320;
/** 관심 영역 갱신 최소 이동량 (IPC 줄이기) */
const INTEREST_STEP = 24;

export class FollowBox {
  rect: CssRect = { x: 0, y: 0, width: 1, height: 1 };
  private sentInterest: CssRect | null = null;
  /** 빠른 메뉴 등 캐릭터와 떨어져 있어도 커서를 받아야 하는 추가 관심 영역 */
  private extraInterest: CssRect | null = null;
  private appliedSize = "";
  private appliedTransform = "";

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onResize: () => void,
  ) {
    canvas.style.position = "fixed";
    canvas.style.left = "0";
    canvas.style.top = "0";
    canvas.style.willChange = "transform";
  }

  /** 발 위치(CSS px)와 캐릭터 키로 상자를 갱신한다. */
  update(feetX: number, feetY: number, characterHeight: number, shape: BoxShape = STANDING_BOX): CssRect {
    const width = Math.ceil(characterHeight * shape.widthRatio);
    const height = Math.ceil(characterHeight * shape.heightRatio);
    return this.apply(feetX - width / 2, feetY + characterHeight * shape.footPadRatio - height, width, height);
  }

  /** 몸 중심 기준 정사각형 상자 (들렸을 때·떨어질 때: 기울고 다리가 처져도 잘리지 않게) */
  around(centerX: number, centerY: number, size: number): CssRect {
    const side = Math.ceil(size);
    return this.apply(centerX - side / 2, centerY - side / 2, side, side);
  }

  private apply(left: number, top: number, width: number, height: number): CssRect {
    // 정수 px에 맞춰야 캔버스가 흐려지지 않는다.
    const x = Math.round(left);
    const y = Math.round(top);
    this.rect = { x, y, width, height };

    const size = `${width}x${height}`;
    if (size !== this.appliedSize) {
      this.appliedSize = size;
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
      this.onResize();
    }
    const transform = `translate3d(${x}px, ${y}px, 0)`;
    if (transform !== this.appliedTransform) {
      this.appliedTransform = transform;
      this.canvas.style.transform = transform;
    }
    this.syncInterest();
    return this.rect;
  }

  contains(x: number, y: number): boolean {
    const { rect } = this;
    return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
  }

  /** 빠른 메뉴가 열려 있는 동안 캐릭터가 멀어져도 메뉴 위 커서 이벤트를 계속 받도록 관심 영역에 합친다 */
  setExtraInterest(rect: CssRect | null): void {
    this.extraInterest = rect;
    this.syncInterest(true);
  }

  private syncInterest(force = false): void {
    let left = this.rect.x - INTEREST_MARGIN;
    let top = this.rect.y - INTEREST_MARGIN;
    let right = this.rect.x + this.rect.width + INTEREST_MARGIN;
    let bottom = this.rect.y + this.rect.height + INTEREST_MARGIN;
    if (this.extraInterest) {
      const pad = 24;
      left = Math.min(left, this.extraInterest.x - pad);
      top = Math.min(top, this.extraInterest.y - pad);
      right = Math.max(right, this.extraInterest.x + this.extraInterest.width + pad);
      bottom = Math.max(bottom, this.extraInterest.y + this.extraInterest.height + pad);
    }
    const interest: CssRect = { x: left, y: top, width: right - left, height: bottom - top };
    const sent = this.sentInterest;
    if (
      !force &&
      sent &&
      Math.abs(sent.x - interest.x) < INTEREST_STEP &&
      Math.abs(sent.y - interest.y) < INTEREST_STEP &&
      Math.abs(sent.width - interest.width) < INTEREST_STEP &&
      Math.abs(sent.height - interest.height) < INTEREST_STEP
    ) {
      return;
    }
    this.sentInterest = interest;
    void setInterestRect(interest);
  }
}
