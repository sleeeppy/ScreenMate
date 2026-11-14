/**
 * 캐릭터 행동: 상태 머신 + 몸(발 위치) 물리. 순수 TS (Node에서 테스트).
 *
 * 좌표는 화면 CSS px (y 아래로 증가). 발 위치가 캐릭터의 기준점이다.
 *
 *   idle ──타이머──▶ walk ──시간/화면 끝──▶ idle
 *    │ ▲
 *    │ └── land ◀── fall ◀── 놓기(던지기) ── held ◀── 잡고 끌기 (어느 상태에서든)
 *    └── 클릭: 머리 → pat, 몸 → poke ──▶ idle
 *
 * 자율 행동 (variety): 서 있기가 끝나면 지금 자리(바닥·창 위)와 할 수 있는 것에 따라 가중치로 고른다.
 *   바닥: 걷기, 두리번, 기지개, 바닥에 앉기, 닿는 창 아래로 걸어가 뛰어오르기(jump → fall), 화면 밖으로 나가기
 *   창 위: 걷기, 걸터앉기, 두리번, 기지개, 창 끝까지 걸어가 뛰어내리기
 *   화면 밖으로 나갈 때: 끝 가까이 걸어가 (가끔 두리번거린 뒤) 걸어 나간다.
 *   화면 밖(away) → 끝에서 보통 크기로 고개만 내밀어 둘러보고 그쪽에서 걸어 들어오기 / 옆·아래에서 크게 엿보기(2.3배) /
 *   그냥 걸어 들어오기. 갑자기 나타나지 않게 늘 천천히 드러난다.
 *
 * 발판은 바닥(작업 영역 아래) 또는 창 위쪽 테두리(Ledge). 창 위에 서 있으면 창을 따라 움직이고,
 * 창이 사라지거나(닫힘·최소화·가려짐) 세게 흔들리거나 끝에서 발을 헛디디면 떨어진다.
 * 떨어질 때는 위에서 아래로 지나는 테두리에만 착지한다 (아래에서 올라갈 때는 통과).
 */
import { clamp, damp } from "../motion/math.ts";
import type { Ledge } from "./platforms.ts";

export type BehaviorState =
  | "idle"
  | "walk"
  | "held"
  | "fall"
  | "land"
  | "react"
  | "act"
  | "sit"
  | "sleep"
  | "rise"
  /** 뛰기 전 웅크리기 (발은 바닥·창에) */
  | "jump"
  /** 화면 밖에 나가 있음 */
  | "away"
  /** 화면 가장자리에서 크게 엿보기 */
  | "peek";

export interface BehaviorOptions {
  /**
   * 서 있다가 가끔 두리번거리기·기지개, 창 위에서 걸터앉기, 바닥에 앉기를 한다.
   * 난수를 더 쓰므로 기존 행동 테스트(고정 난수 순서)와 섞이지 않게 앱에서만 켠다.
   */
  variety?: boolean;
  /** 이 시간(초) 동안 사용자 입력이 없으면 앉아서 존다 (기본 10분) */
  sleepAfter?: number;
}
export type BehaviorActivity = "interact" | "near" | "idle";

export interface Arena {
  /** 발이 닿는 바닥 y (작업표시줄 위) */
  ground: number;
  left: number;
  right: number;
  top: number;
  /** 창 위쪽 테두리 발판 */
  ledges?: readonly Ledge[];
  /** 이쪽에 맞닿은 모니터가 있어 날아가면 벽에 튕기지 않고 넘어간다 (넘어가는 처리는 무대가 한다) */
  openLeft?: boolean;
  openRight?: boolean;
  /** 화면 맨 아래 y (작업표시줄 포함). 아래에서 엿볼 때 여기서 올라온다. 없으면 ground */
  bottom?: number;
}

export interface Actor {
  /** 캐릭터 키 (頭 높이) px */
  readonly heightPx: number;
  /** 걷기 모션과 발이 미끄러지지 않는 몸 이동 속도 (정면 기준) px/s */
  readonly walkSpeedPx: number;
  play(motion: string, onFinished?: () => void): void;
  /** 걷다가 지금 멈춰도 되는지 (두 발이 몸 아래에서 엇갈리는 순간). 없으면 언제든 멈춘다. */
  canStopWalking?(): boolean;
}

export interface Point {
  x: number;
  y: number;
}

/** 걷기 때 몸을 돌리는 각도. 완전 옆모습(90°)보다 3/4가 표정이 보여 좋다. */
export const WALK_FACING = (70 * Math.PI) / 180;
const GRAVITY = 2600;
const MAX_THROW = 3000;
/** 이 속도(px/s) 이상으로 떨어지면 착지 모션 */
const LAND_IMPACT = 650;
const WALL_BOUNCE = 0.35;
/** 들린 채 흔들림: 진자 고유 진동수(Hz)와 감쇠비 */
const SWAY_HZ = 0.85;
const SWAY_DAMPING = 0.22;
const SWAY_MAX = (38 * Math.PI) / 180;
/** 진자 목표 기울기는 이 값에 부드럽게 다가간다 (tanh). SWAY_MAX에 딱 부딪혀 멈추지 않게. */
const SWAY_TARGET_MAX = SWAY_MAX * 0.75;
/** 끄는 속도에서 나온 목표 기울기를 이 반감기(초)로 거른다. 프레임 간격이 고르지 않으면 속도가 튄다. */
const SWAY_TARGET_SMOOTH = 0.05;
/** 진자를 이 고정 간격(초)으로 나눠 적분한다 (렌더 간격과 무관하게 매끄럽게) */
const SWAY_STEP = 1 / 240;
/** 끄는 속도 1000px/s당 기울기 */
const SWAY_PER_SPEED = (20 * Math.PI) / 180 / 1000;
/** 창 흔들림 판정: 최근 이 시간(s) 동안 창이 움직인 평균 속력으로 본다 */
const SHAKE_WINDOW = 0.25;
/** 이 속력(px/s) 이상으로 창이 움직이면 떨어진다. 보통 창 끌기는 1000 안팎. */
const SHAKE_SPEED = 2500;
/** 흔들려 떨어질 때 창 속도를 이만큼 물려받는다 */
const SHAKE_CARRY = 0.5;
/** 창 따라가기: 이 시간(초) 넘게 창 위치가 안 바뀌면 멈춘 것으로 본다 / 남은 오차를 메우는 반감기 */
const FOLLOW_STOP_AFTER = 0.05;
const FOLLOW_CATCH_UP = 0.04;
/** 창 속도 어림 상한 (px/s) */
const FOLLOW_MAX_SPEED = 4000;
/** 흔들려 떨어질 때 위로 튕기는 속도 (px/s) */
const SHAKE_HOP = 420;
/** 창 끝에 닿았을 때 발을 헛디뎌 떨어질 확률 (나머지는 돌아서기·멈추기) */
const STEP_OFF_CHANCE = 0.2;
/** 놓은 발이 테두리에서 이 범위(위 / 아래 px) 안이면 그 창 위에 바로 선다 */
const LEDGE_SNAP = { above: 12, below: 6 };
/**
 * 놓을 때 엉덩이가 창 위쪽 테두리 근처면 그 테두리에 바로 걸터앉는다. 엉덩이(足 본)가 테두리에서 위로 above, 아래로 below
 * (키 배수) 안이면 앉는다. 엉덩이 아래 끝이 테두리에 닿은 것처럼 보일 때 足 본은 테두리보다 조금 위라 위쪽을 넉넉히 둔다
 * (위에서 놓으면 떨어져 앉는다). 매달린 자세의 足 본은 발에서 키의 hangHip배 위 (Sour 린에서 잼).
 * 세게 던지면(maxSpeed px/s 넘게) 앉지 않고 날아간다.
 * 발 기준점은 바로 테두리로 옮기고, 그림은 놓은 자리에서 glide초 동안 테두리로 올라간다. 같은 시간에 모션(sit_drop_edge)이
 * 엉덩이를 매달린 높이에서 앉은 높이로 내려서 화면에서는 엉덩이가 거의 그 자리에 있다. 한 프레임에 바꾸면 물리가 몸이
 * 9단위 순간이동한 것으로 보고 치마·머리카락이 폭주했다 (clips/sit.ts sitDropEdge 8프레임과 같게).
 */
const SEAT_DROP = { above: 0.25, below: 0.08, hangHip: 0.62, maxSpeed: 900, glide: 8 / 30 };
/** 걷다 멈출 때 발이 엇갈리는 순간을 이만큼(초)까지 기다린다 (반 걸음 = 0.5초) */
const STOP_WAIT_MAX = 0.6;
/**
 * 들고 있은 지 이만큼(초) 지나거나, 잡은 손의 평균 속력(0.3초 지수 평균, px/s)이 이 값을 넘으면 버둥거린다.
 * 진자(0.85Hz) 흔들림으로 재면 빠르게 흔들수록 오히려 작아져서 손 속력으로 잰다. 보통 끌기는 1000 안팎.
 */
const STRUGGLE_AFTER = 3;
const STRUGGLE_SHAKE = 1800;
/** 버둥거리기를 한 번 시작하면 최소 이만큼(초)은 계속한다 (깜빡이지 않게) */
const STRUGGLE_MIN = 1.2;
/**
 * 서 있기가 끝났을 때 고르는 가중치 (variety). 할 수 없는 것(닿는 창 없음, 화면 밖 나가기 쉬는 중)은 빼고 고른다.
 * 순서대로 누적해 고른다 (테스트의 고정 난수: 바닥에서 0.82 → 두리번, 0.95 → 기지개, 창 위에서 0.1 → 걸터앉기).
 */
const GROUND_CHOICES = { walk: 36, sitFloor: 6, climb: 20, leave: 14, look: 12, stretch: 7 };
const LEDGE_CHOICES = { sitEdge: 26, walk: 32, hopDown: 18, look: 12, stretch: 5 };
/** 화면 밖으로 나갔다 오기는 이만큼(초)에 한 번까지. 처음에는 30초 뒤부터 */
const LEAVE_COOLDOWN = 50;
const LEAVE_FIRST = 20;
/** 점프: 웅크리는 시간(초), 뛰어오를 수 있는 높이(키 배수), 꼭대기 여유(키 배수) */
const JUMP_CROUCH = 0.3;
const JUMP_MIN_RISE = 0.45;
const JUMP_MAX_RISE = 3.2;
const JUMP_APEX = 0.35;
/** 뛰었을 때 발이 올라갈 수 있는 가장 높은 곳: 화면 위 + 키 배수 (updateFall의 머리 한계 1.15보다 조금 아래) */
const JUMP_TOP = 1.16;
/** 창 아래에서 목표보다 이만큼(키 배수) 옆에 서서 비스듬히 뛴다 */
const JUMP_RUNUP = 0.35;
/** 창에서 뛰어내리기: 위·옆 속도 (px/s) */
const HOP_DOWN = { up: 520, side: 240 };
/**
 * 화면 밖에 있는 시간 (초). 엿본 뒤에는 조금 짧게. 몇 초 만에 나간 쪽에서 다시 나오면 툭 튀어나오는 것처럼 보였다.
 */
const AWAY_SECONDS = { min: 6, max: 15 };
const AFTER_PEEK_SECONDS = { min: 3, max: 6 };
/** 돌아올 때 나간 반대쪽에서 들어올 확률 (화면 뒤로 돌아온 느낌) */
const ENTER_OPPOSITE = 0.7;
/** 화면 밖 어디에 서 있나 (키 배수, 화면 끝에서 바깥으로). 멈추고 돌아서는 동안 다 숨게 넉넉히 */
const OFFSTAGE = 1.0;
/**
 * 크게 엿보기: 배율, 들어오기·나가기 시간(초), 머무는 시간, 옆에서 기울이는 각도(라디안),
 * 옆 엿보기 발 위치(큰 키 배수만큼 화면 밖), 아래 엿보기에서 보이는 부분(큰 키 배수),
 * 아래 엿보기에서 숨을 때 발 위치(큰 키 배수만큼 화면 아래 밖). 머리카락·리본이 키보다 위로 솟은 모델도 다 숨게 넉넉히
 */
const PEEK = {
  scale: 2.3,
  in: 1.6,
  out: 1.1,
  hold: { min: 2.8, max: 5 },
  lean: 0.6,
  side: 0.36,
  upVisible: 0.26,
  upHidden: 1.45,
  facing: 0.18,
};
/** 돌아올 때 고르는 확률: 보통 크기로 고개 내밀고 들어오기, 옆에서 크게, 아래에서 크게. 나머지는 그냥 걸어 들어오기 */
const RETURN_CHOICES = { peekIn: 0.4, bigSide: 0.25, bigUp: 0.2 };
/** 고개 내밀어 둘러보는 시간 (초) */
const PEEK_IN_HOLD = { min: 1.6, max: 2.8 };
/** 화면 밖으로 나가기 전 끝 가까이에서 두리번거릴 확률 */
const GLANCE_BEFORE_LEAVE = 0.5;
/** 걸터앉거나 바닥에 앉아 있는 시간 (초) */
const SIT_SECONDS = { min: 8, max: 18 };
/**
 * 앉을 때 몸을 돌리는 각도 (라디안, 30°). 먼저 이만큼 돌아선 뒤 앉기 시작하고, 앉아 있는 동안·일어서는 동안 그대로 둔다
 * (앉는 중에 각도를 바꾸면 몸이 비틀리는 것처럼 보였다). 다 일어선 뒤에 정면으로 돈다.
 * 정면 카메라라 너무 정면이면 쪼그릴 때 허벅지가 화면 쪽을 향해 몸이 꺼지는 것처럼 보인다.
 */
const SIT_FACING = (30 * Math.PI) / 180;
/** 앉았을 때 머리 꼭대기 높이 / 선 키 (clips/sit.ts SIT_HEAD_RATIO와 같게) */
const SIT_HEAD_RATIO = 0.42;

export class Behavior {
  state: BehaviorState = "idle";
  feet: Point = { x: 0, y: 0 };
  /** 몸 방향 (라디안, 0 = 정면, + = 화면 왼쪽을 봄) */
  facing = 0;
  /** 화면에서 반시계 방향 기울기 (라디안). 들렸을 때 흔들림 */
  roll = 0;
  /** true면 자율 행동을 멈추고 지정 모션만 (미리보기·검증) */
  paused = false;
  /** 그리는 크기 배율 (크게 엿보기 때 2.3). 무대가 키에 곱한다. 화면 밖에 있을 때만 바뀐다 */
  displayScale = 1;

  private velocity: Point = { x: 0, y: 0 };
  private targetFacing = 0;
  private stateTime = 0;
  private stateLength = 0;
  private walkDirection: 1 | -1 = 1;
  private rollVelocity = 0;
  /** 거른 진자 목표 기울기 */
  private swayTarget = 0;
  private grabOffset: Point = { x: 0, y: 0 };
  private pointer: Point = { x: 0, y: 0 };
  private held: Point = { x: 0, y: 0 };
  private samples: { x: number; y: number; t: number }[] = [];
  /** 서 있는 창 id (null = 바닥) */
  private ledgeId: number | null = null;
  /** 마지막으로 본 발판 창 위치 (창 이동량 계산용) */
  private ledgeAnchor: Point = { x: 0, y: 0 };
  /** 최근 창 이동 평균 속력 / 평균 속도 (SHAKE_WINDOW 지수 평균, px/s) */
  private ledgeSpeed = 0;
  private ledgeVelocity: Point = { x: 0, y: 0 };
  /** 화면에 보이는 발판 창 위치(부드럽게 따라감), 창 속도 어림, 마지막 위치 변화 뒤 시간 */
  private ledgeShown: Point = { x: 0, y: 0 };
  private ledgeEstimate: Point = { x: 0, y: 0 };
  private ledgeSampleAge = 0;
  /** 떨어져 나온 창: 바닥이나 다른 창에 닿을 때까지 그 창에는 착지하지 않는다 */
  private ignoredLedge: number | null = null;
  /** 걷기를 멈추려고 발이 엇갈리는 순간을 기다리는 중 (blocked면 제자리에서) */
  private stopping: { time: number; blocked: boolean } | null = null;
  /** 창 끝에서 발을 헛디뎌 걸어 나가는 중 */
  private steppingOff = false;
  /** 정한 곳까지 걷기 (닿으면 then). offscreen이면 화면 끝을 넘어 걷는다 */
  private goal: { x: number; offscreen: boolean; then: () => void } | null = null;
  /** 목표에 닿아 멈추는 중: 멈추면 이어서 할 일 */
  private arrived: (() => void) | null = null;
  /** 웅크렸다 뛸 때의 속도와 무시할 창 (뛰어내린 창) */
  private launch: { velocity: Point; ignore: number | null } | null = null;
  /** 지난번 화면 밖에 나간 뒤 시간 (초) */
  private sinceLeave = LEAVE_COOLDOWN - LEAVE_FIRST;
  /** 나간 쪽, 화면 밖에서 다음에 할 일 */
  private awaySide: "left" | "right" = "left";
  private awayNext: "return" | "walkIn" = "return";
  /** 크게 엿보기 진행 */
  private peekState: {
    kind: "left" | "right" | "up";
    phase: "in" | "hold" | "out";
    time: number;
    hold: number;
    in: number;
    out: number;
    from: Point;
    to: Point;
    /** 보통 크기로 고개만 내밀기 (끝나면 그쪽에서 걸어 들어온다) */
    small: boolean;
  } | null = null;
  /** 순간이동했다 (무대가 물리를 다시 놓는다) */
  private teleported = false;
  /** 앉을 방향으로 돌아서는 중: 다 돌면 재생할 앉기 모션과 이어서 반복할 모션 */
  private pendingSit: { motion: string; loop: string } | null = null;
  /** 스스로 뛴 공중 (착지 때 늘 착지 모션) */
  private jumped = false;

  // Node 타입 제거 모드는 생성자 매개변수 속성을 지원하지 않아 필드를 따로 둔다.
  private readonly actor: Actor;
  private readonly random: () => number;
  private options: BehaviorOptions;
  /** 앉는 모션을 하는 중 (반복 모션으로 넘어가기 전) / 일어서는 중의 앉은 자세 */
  private seatMoving = false;
  /** 놓아서 걸터앉을 때 그림이 놓은 자리에서 테두리로 올라가는 오프셋 (px, 아래가 +). 발 기준점은 이미 테두리에 있다. */
  private settle = { from: 0, time: 0 };
  /**
   * 몸은 그 자리인데 발 기준점만 옮겼을 때 옮긴 양 (px). 무대가 물리 기준점을 그만큼 되돌려 물리 세계에서도 몸이 튀지 않게 한다.
   * (물리는 화면 이동의 일부만 보므로 발 기준점이 뛰고 센터 본이 반대로 뛰면 물리 세계에서는 엉덩이가 확 끌려간다.)
   */
  private reanchored: Point | null = null;
  private riseSeat: "edge" | "floor" = "floor";
  /** 미리보기에서 보여 줄 앉은 자세 */
  private previewSeat: "edge" | "floor" | null = null;
  /** 마지막 사용자 입력 이후 시간 (초) */
  private quietTime = 0;
  /** 들고 있은 시간, 진자 흔들림 속도 평균, 버둥거리기 중인지 */
  private heldTime = 0;
  private shake = 0;
  private struggling = false;
  private struggleTime = 0;

  constructor(actor: Actor, random: () => number = Math.random, options: BehaviorOptions = {}) {
    this.actor = actor;
    this.random = random;
    this.options = options;
  }

  /** 박스를 넉넉하게(회전·매달림 포함) 잡아야 하는 상태인지 */
  /**
   * 몸이 매달린 기준점 (CSS px): 들고 있으면 잡은 점(커서), 아니면 가슴 높이.
   * 물리용 월드 위치를 이 점 기준으로 줄인다 (engine.ts PHYSICS_TRAVEL). 발 기준으로 줄이면
   * 들고 흔들 때 화면에서는 가만히 있는 목이 물리 세계에서는 크게 휘둘린다.
   */
  get pivot(): Point {
    if (this.state === "held") return { ...this.held };
    const chest = rotateCss({ x: 0, y: -this.actor.heightPx * 0.6 }, this.roll);
    const feet = this.shownFeet;
    return { x: feet.x + chest.x, y: feet.y + chest.y };
  }

  /** 그릴 발 위치: 놓아서 걸터앉는 동안은 테두리보다 위(또는 아래)에서 내려앉는다 */
  get shownFeet(): Point {
    const { from, time } = this.settle;
    if (from === 0) return { ...this.feet };
    const t = Math.min(1, time / SEAT_DROP.glide);
    return { x: this.feet.x, y: this.feet.y + from * (1 - t * t * (3 - 2 * t)) };
  }

  get airborne(): boolean {
    return this.state === "held" || this.state === "fall";
  }

  /** 발 기준점만 옮겼으면 한 번 그 양 (px) */
  consumeReanchor(): Point | null {
    const shift = this.reanchored;
    this.reanchored = null;
    return shift;
  }

  /** 순간이동했으면 한 번 true (무대가 물리 강체를 새 자리에 다시 놓는다) */
  consumeTeleport(): boolean {
    const teleported = this.teleported;
    this.teleported = false;
    return teleported;
  }

  /** 창 위에 서 있는지 (Rust 창 폴링을 빠르게 할지) */
  get onLedge(): boolean {
    return this.ledgeId !== null;
  }

  /** 앉은 자세: 창 테두리에 걸터앉았는지, 바닥에 앉았는지 (상자 모양·클릭 판정용) */
  get seat(): "edge" | "floor" | null {
    if (this.state === "rise") return this.riseSeat;
    if (this.state !== "sit" && this.state !== "sleep") return null;
    if (this.paused && this.previewSeat) return this.previewSeat;
    return this.ledgeId !== null ? "edge" : "floor";
  }

  /** 발 기준점에서 머리 꼭대기까지 높이 (px). 앉으면 낮아진다. */
  get headHeight(): number {
    return this.actor.heightPx * (this.seat ? SIT_HEAD_RATIO : 1);
  }

  /** 설정 창에서 바꾼 옵션 (다양한 동작, 졸기까지 시간) */
  configure(options: BehaviorOptions): void {
    this.options = { ...this.options, ...options };
  }

  /** 사용자 입력(커서 근처·클릭·끌기)이 있었다. 졸고 있었으면 깬다. */
  noteActivity(): void {
    this.quietTime = 0;
    if (this.state === "sleep" && !this.paused) this.rise();
  }

  activity(): BehaviorActivity {
    if (this.state === "held" || this.state === "fall" || this.state === "land" || this.state === "react") return "interact";
    if (this.state === "jump") return "interact";
    // 엿보며 들어오고 나가는 동안은 크게 움직이니 매 프레임, 머무는 동안은 시선만
    if (this.state === "peek") return this.peekState?.phase === "hold" ? "near" : "interact";
    if (this.state === "away") return "idle";
    if (this.state === "act") return "near";
    // 앉는 중·일어서는 중은 매 프레임 그린다
    if (this.state === "rise" || this.seatMoving) return "interact";
    // 서 있는 창이 움직이는 동안은 매 프레임 그려야 매끄럽게 따라간다
    if (this.ledgeId !== null && this.ledgeSpeed > 20) return "interact";
    if (this.state === "walk" || Math.abs(this.facing - this.targetFacing) > 0.02) return "near";
    return "idle";
  }

  /** 땅 위 지정 위치에서 시작 */
  place(x: number, arena: Arena): void {
    this.resetScale();
    this.feet = { x: clamp(x, arena.left + this.margin(), arena.right - this.margin()), y: arena.ground };
    this.ledgeId = null;
    this.velocity = { x: 0, y: 0 };
    this.enter("idle", 3 + this.random() * 4);
  }

  /** 화면 크기가 바뀌었을 때: 땅에 있으면 새 바닥에 맞추고 화면 안으로 */
  fit(arena: Arena): void {
    // 화면 밖에 나가 있거나 엿보는 중이면 그대로 (화면 안으로 당기면 갑자기 나타난다)
    if (this.state === "away" || this.state === "peek" || this.goal?.offscreen || this.arrived) return;
    const margin = this.margin();
    this.feet.x = clamp(this.feet.x, arena.left + margin, arena.right - margin);
    if (!this.airborne && this.ledgeId === null) this.feet.y = arena.ground;
  }

  /** 다른 모니터로 옮겨 좌표 원점이 바뀌었을 때: 화면 좌표로 들고 있는 값을 모두 같은 만큼 옮긴다 */
  translate(dx: number, dy: number): void {
    const shift = (point: Point) => {
      point.x += dx;
      point.y += dy;
    };
    shift(this.feet);
    shift(this.pointer);
    shift(this.held);
    shift(this.ledgeAnchor);
    shift(this.ledgeShown);
    shift(this.ledgeEstimate);
    for (const sample of this.samples) shift(sample);
  }

  /** 공중 한 점에서 떨어뜨린다 (검증용 `--drop-on-window`) */
  dropFrom(point: Point): void {
    this.feet = { ...point };
    this.ledgeId = null;
    this.ignoredLedge = null;
    this.velocity = { x: 0, y: 0 };
    this.targetFacing = 0;
    this.enter("fall");
    this.actor.play("fall");
  }

  /** 미리보기: 자율 행동을 멈추고 모션만 재생 (걷기는 제자리에서 옆으로 돈 채로) */
  preview(motion: string): void {
    this.paused = true;
    this.resetScale();
    // 앉기 미리보기는 앉은 상태로 둔다 (캔버스 상자·클릭 판정이 앉은 자세에 맞게)
    const seated = motion.startsWith("sit_") || motion.startsWith("sleep_");
    this.previewSeat = seated ? (motion.endsWith("_edge") ? "edge" : "floor") : null;
    this.enter(seated ? (motion.startsWith("sleep_") ? "sleep" : "sit") : "idle");
    const turning = seated || motion.startsWith("sit_down_") || motion.startsWith("stand_up_");
    this.targetFacing = motion === "walk" ? -WALK_FACING : turning ? -SIT_FACING : 0;
    // 앉는 모션은 실제 행동처럼 끝나면 앉기 반복으로 이어서 보여 준다
    if (motion.startsWith("sit_down_")) {
      const seat = motion.endsWith("_edge") ? "edge" : "floor";
      this.previewSeat = seat;
      this.enter("sit");
      this.actor.play(motion, () => this.actor.play(`sit_${seat}`));
      return;
    }
    this.actor.play(motion);
  }

  /** 미리보기 끝: 자율 행동으로 */
  resume(): void {
    this.paused = false;
    this.toIdle();
  }

  update(dt: number, arena: Arena): void {
    this.stateTime += dt;
    this.updateSettle(dt);
    if (!this.airborne && this.ledgeId !== null) this.followLedge(dt, arena);
    switch (this.state) {
      case "idle":
        this.updateIdle(arena);
        break;
      case "jump":
        this.updateJump();
        break;
      case "away":
        this.updateAway(arena);
        break;
      case "peek":
        this.updatePeek(dt, arena);
        break;
      case "walk":
        this.updateWalk(dt, arena);
        break;
      case "held":
        this.updateHeld(dt);
        break;
      case "fall":
        this.updateFall(dt, arena);
        break;
      case "sit":
        this.beginSitDownWhenTurned();
        if (!this.paused && !this.seatMoving && this.stateTime >= this.stateLength) this.rise();
        break;
      case "rise":
        break;
      case "sleep":
        this.beginSitDownWhenTurned();
        break;
      case "land":
      case "react":
      case "act":
        break;
    }
    // 오래 아무 입력이 없으면 그 자리에 앉아 존다 (창 위면 걸터앉아서)
    if (!this.airborne && !this.paused) {
      this.quietTime += dt;
      const sleepAfter = this.options.sleepAfter ?? 600;
      if (this.quietTime >= sleepAfter && (this.state === "idle" || this.state === "sit")) this.sit(true);
    }
    this.sinceLeave += dt;
    if (!this.airborne && this.state !== "peek") {
      this.roll = damp(this.roll, 0, 0.08, dt);
      this.rollVelocity = 0;
    }
    this.facing = damp(this.facing, this.targetFacing, this.state === "walk" ? 0.1 : 0.16, dt);
  }

  // ---------------------------------------------------------------- 입력

  /** 캐릭터 위에서 눌러 끌기 시작 (크게 엿보는 중·화면 밖에서는 잡히지 않는다) */
  grab(pointer: Point, now: number): void {
    if (this.state === "peek" || this.state === "away") return;
    this.jumped = false;
    this.grabOffset = { x: this.feet.x - pointer.x, y: this.feet.y - pointer.y };
    this.pointer = { ...pointer };
    this.held = { ...pointer };
    this.samples = [{ ...pointer, t: now }];
    this.velocity = { x: 0, y: 0 };
    this.rollVelocity = 0;
    this.swayTarget = 0;
    this.targetFacing = 0;
    this.ledgeId = null;
    this.ignoredLedge = null;
    this.heldTime = 0;
    this.shake = 0;
    this.struggling = false;
    this.quietTime = 0;
    this.settle = { from: 0, time: 0 };
    this.enter("held");
    this.actor.play("hang");
  }

  drag(pointer: Point, now: number): void {
    if (this.state !== "held") return;
    this.pointer = { ...pointer };
    this.samples.push({ ...pointer, t: now });
    // 최근 0.1초만 남겨 던지는 속도를 잰다
    while (this.samples.length > 2 && now - this.samples[0].t > 100) this.samples.shift();
  }

  release(now: number, arena: Arena): void {
    if (this.state !== "held") return;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const span = (last.t - first.t) / 1000;
    const stale = now - last.t > 80; // 멈췄다 놓으면 속도 0
    const velocity =
      span > 0.01 && !stale ? { x: (last.x - first.x) / span, y: (last.y - first.y) / span } : { x: 0, y: 0 };
    const speed = Math.hypot(velocity.x, velocity.y);
    const scale = speed > MAX_THROW ? MAX_THROW / speed : 1;
    this.velocity = { x: velocity.x * scale, y: velocity.y * scale };
    const ledge =
      this.velocity.y >= 0
        ? arena.ledges?.find(
            (candidate) =>
              this.feet.x >= candidate.left &&
              this.feet.x <= candidate.right &&
              this.feet.y >= candidate.y - LEDGE_SNAP.above &&
              this.feet.y <= candidate.y + LEDGE_SNAP.below,
          )
        : undefined;
    if (ledge) {
      this.standOn(ledge);
      this.velocity = { x: 0, y: 0 };
      this.toIdle();
      return;
    }
    const seat = this.velocity.y >= 0 && speed <= SEAT_DROP.maxSpeed ? this.seatUnderHips(arena) : null;
    if (seat) {
      this.sitDropped(seat.ledge, seat.hip);
      return;
    }
    if (this.feet.y >= arena.ground - 2 && this.velocity.y >= 0) {
      this.feet.y = arena.ground;
      this.velocity = { x: 0, y: 0 };
      this.toIdle();
      return;
    }
    this.enter("fall");
    this.actor.play("fall");
  }

  /** 매달린 엉덩이 바로 아래·위에 있는 창 테두리 (놓으면 거기 걸터앉는다) */
  private seatUnderHips(arena: Arena): { ledge: Ledge; hip: Point } | null {
    const height = this.actor.heightPx;
    const offset = rotateCss({ x: 0, y: -height * SEAT_DROP.hangHip }, this.roll);
    const hip = { x: this.feet.x + offset.x, y: this.feet.y + offset.y };
    const edge = height * 0.12;
    const ledge = arena.ledges?.find(
      (candidate) =>
        hip.x >= candidate.left + edge &&
        hip.x <= candidate.right - edge &&
        hip.y >= candidate.y - height * SEAT_DROP.above &&
        hip.y <= candidate.y + height * SEAT_DROP.below,
    );
    return ledge ? { ledge, hip } : null;
  }

  /** 놓은 자리에서 바로 걸터앉는다. 발은 테두리로 옮기고, 몸은 놓은 높이에서 테두리까지 내려앉는다 (settle). */
  private sitDropped(ledge: Ledge, hip: Point): void {
    const before = { ...this.feet };
    this.standOn(ledge);
    this.feet.x = hip.x;
    this.reanchored = { x: this.feet.x - before.x, y: this.feet.y - before.y };
    this.velocity = { x: 0, y: 0 };
    this.settle = { from: before.y - ledge.y, time: 0 };
    this.targetFacing = -this.walkDirection * SIT_FACING;
    this.enter("sit", SIT_SECONDS.min + this.random() * (SIT_SECONDS.max - SIT_SECONDS.min));
    this.seatMoving = true;
    this.actor.play("sit_drop_edge", () => {
      this.seatMoving = false;
      if (this.state === "sit") this.actor.play("sit_edge");
    });
  }

  private updateSettle(dt: number): void {
    if (this.settle.from === 0) return;
    this.settle.time += dt;
    if (this.settle.time >= SEAT_DROP.glide) this.settle = { from: 0, time: 0 };
  }

  /** 끌지 않고 짧게 클릭 */
  click(pointer: Point): void {
    // 크게 엿보다가 눌리면 부끄러워 얼른 숨는다
    if (this.state === "peek" && this.peekState && this.peekState.phase !== "out") {
      this.peekState.phase = "out";
      this.peekState.time = 0;
      this.peekState.out *= 0.6;
      return;
    }
    if (this.airborne || this.state === "land" || this.state === "rise") return;
    this.quietTime = 0;
    // 머리 꼭대기(서 있으면 頭 높이 = heightPx, 앉으면 더 낮다)보다 살짝 아래부터 머리로 본다.
    const head = pointer.y < this.feet.y - this.headHeight * 0.9;
    // 앉아 있을 때 머리를 쓰다듬으면 앉은 채로 반응한다 (졸고 있었으면 깨서). 찌르면 일어선 다음 반응한다.
    const seat = this.seat;
    if (seat && !this.paused) {
      if (head) this.patSeated(seat);
      else this.rise("poke");
      return;
    }
    this.targetFacing = 0;
    this.enter("react");
    this.actor.play(head ? "pat" : "poke", () => this.toIdle());
  }

  // ---------------------------------------------------------------- 상태별

  private updateIdle(arena: Arena): void {
    if (this.paused || this.stateTime < this.stateLength) return;
    if (this.options.variety) {
      this.chooseNext(arena);
      return;
    }
    this.wander();
  }

  private wander(): void {
    this.walkDirection = this.random() < 0.5 ? 1 : -1;
    this.enter("walk", 2 + this.random() * 4);
    this.actor.play("walk");
  }

  /** 다음에 할 일을 가중치로 고른다. 할 수 없는 것은 빼고 */
  private chooseNext(arena: Arena): void {
    const onLedge = this.ledgeId !== null;
    // 할 수 있는지만 먼저 본다 (난수는 고른 뒤에 쓴다: 고르기 난수 순서가 바뀌지 않게)
    const climbs = onLedge ? [] : this.climbCandidates(arena);
    const hops = onLedge ? this.hopSpots(arena) : [];
    const canLeave = !onLedge && this.sinceLeave >= LEAVE_COOLDOWN;
    const choices: [string, number][] = onLedge
      ? [
          ["sitEdge", LEDGE_CHOICES.sitEdge],
          ["walk", LEDGE_CHOICES.walk],
          ["hopDown", hops.length ? LEDGE_CHOICES.hopDown : 0],
          ["look", LEDGE_CHOICES.look],
          ["stretch", LEDGE_CHOICES.stretch],
        ]
      : [
          ["walk", GROUND_CHOICES.walk],
          ["sitFloor", GROUND_CHOICES.sitFloor],
          ["climb", climbs.length ? GROUND_CHOICES.climb : 0],
          ["leave", canLeave ? GROUND_CHOICES.leave : 0],
          ["look", GROUND_CHOICES.look],
          ["stretch", GROUND_CHOICES.stretch],
        ];
    const total = choices.reduce((sum, [, weight]) => sum + weight, 0);
    let pick = this.random() * total;
    let choice = "walk";
    for (const [name, weight] of choices) {
      if (pick < weight) {
        choice = name;
        break;
      }
      pick -= weight;
    }
    switch (choice) {
      case "sitEdge":
      case "sitFloor":
        this.sit(false);
        return;
      case "look":
      case "stretch":
        this.targetFacing = 0;
        this.enter("act");
        this.actor.play(choice === "stretch" ? "idle_stretch" : "idle_look", () => this.toIdle());
        return;
      case "climb": {
        const climb = this.climbFrom(this.pickOne(climbs), arena);
        if (climb) this.walkTo(climb.from, arena, () => this.jumpTo(climb.to, arena));
        else this.wander();
        return;
      }
      case "hopDown": {
        const hop = this.pickOne(hops);
        this.walkTo(hop.x, arena, () => this.hopDown(hop.direction));
        return;
      }
      case "leave":
        this.leaveScreen(arena);
        return;
      default:
        this.wander();
    }
  }

  // ---------------------------------------------------------------- 정한 곳까지 걷기

  /** x까지 걸어가서 then. offscreen이 아니면 걸을 수 있는 범위 안으로 맞춘다 */
  private walkTo(x: number, arena: Arena, then: () => void, offscreen = false): void {
    const { left, right } = this.walkBounds(arena);
    const target = offscreen ? x : clamp(x, left, right);
    if (Math.abs(target - this.feet.x) < 2) {
      then();
      return;
    }
    this.walkDirection = target >= this.feet.x ? 1 : -1;
    this.enter("walk", Number.POSITIVE_INFINITY);
    this.goal = { x: target, offscreen, then };
    this.actor.play("walk");
  }

  // ---------------------------------------------------------------- 창 위로 뛰어오르기·뛰어내리기

  /**
   * 바닥에서 뛰어오를 창: 너무 낮거나 높지 않고, 꼭대기에서 머리가 화면 위로 나가지 않으며, 설 자리가 넉넉한 테두리.
   * 목표는 테두리 위 한 점, 출발은 그 옆 (비스듬히 뛰어 오른다).
   */
  private climbCandidates(arena: Arena): Ledge[] {
    const h = this.actor.heightPx;
    return (arena.ledges ?? []).filter((ledge) => {
      const rise = this.feet.y - ledge.y;
      const room = ledge.right - ledge.left;
      // 꼭대기는 테두리보다 조금이라도 위여야(위에서 내려앉아야) 하고, 머리가 화면 위로 나가지 않게 (updateFall topLimit)
      const roomAbove = ledge.y - h * 0.08 >= arena.top + JUMP_TOP * h;
      return rise >= JUMP_MIN_RISE * h && rise <= JUMP_MAX_RISE * h && room >= h * 0.7 && roomAbove;
    });
  }

  /** 고른 테두리 위 한 점(지금 자리에서 가까운 곳)과 그 옆 출발 자리 */
  private climbFrom(ledge: Ledge, arena: Arena): { from: number; to: Point } | null {
    const h = this.actor.heightPx;
    const { left, right } = this.walkBounds(arena);
    const edge = h * 0.25;
    const x = clamp(this.feet.x, ledge.left + edge, ledge.right - edge);
    const away = x > this.feet.x ? -1 : 1;
    const from = clamp(x + away * JUMP_RUNUP * h, left, right);
    if (Math.abs(from - x) > JUMP_RUNUP * h * 3) return null;
    return { from, to: { x, y: ledge.y } };
  }

  /** 웅크렸다가 목표 점으로 뛴다: 목표보다 조금 위(JUMP_APEX)가 꼭대기인 포물선. 떨어지면서 테두리에 내려앉는다 */
  private jumpTo(to: Point, arena: Arena): void {
    const h = this.actor.heightPx;
    // 화면 위쪽 창이면 꼭대기를 낮춘다 (머리가 화면 위에 닿으면 updateFall이 막아 올라가지 못한다)
    const apexY = Math.max(Math.min(this.feet.y, to.y) - JUMP_APEX * h, arena.top + JUMP_TOP * h);
    const vy = -Math.sqrt(2 * GRAVITY * Math.max(1, this.feet.y - apexY));
    const flight = -vy / GRAVITY + Math.sqrt((2 * Math.max(0, to.y - apexY)) / GRAVITY);
    const vx = (to.x - this.feet.x) / Math.max(0.1, flight);
    this.walkDirection = vx >= 0 ? 1 : -1;
    this.targetFacing = Math.abs(vx) > 40 ? -this.walkDirection * WALK_FACING * 0.5 : 0;
    this.enter("jump");
    this.launch = { velocity: { x: vx, y: vy }, ignore: null };
    this.actor.play("jump");
  }

  /** 창 위에서 뛰어내릴 끝: 화면 끝과 겹치지 않는 쪽 */
  private hopSpots(arena: Arena): { x: number; direction: 1 | -1 }[] {
    const { left, right } = this.walkBounds(arena);
    const h = this.actor.heightPx;
    const ends: { x: number; direction: 1 | -1 }[] = [];
    if (left > arena.left + this.margin() + h * 0.3) ends.push({ x: left, direction: -1 });
    if (right < arena.right - this.margin() - h * 0.3) ends.push({ x: right, direction: 1 });
    return ends;
  }

  private pickOne<T>(items: readonly T[]): T {
    return items[Math.min(items.length - 1, Math.floor(this.random() * items.length))];
  }

  private hopDown(direction: 1 | -1): void {
    this.walkDirection = direction;
    this.targetFacing = -direction * WALK_FACING * 0.6;
    const from = this.ledgeId;
    this.enter("jump");
    this.launch = { velocity: { x: direction * HOP_DOWN.side, y: -HOP_DOWN.up }, ignore: from };
    this.actor.play("jump");
  }

  private updateJump(): void {
    if (this.stateTime < JUMP_CROUCH || !this.launch) return;
    const { velocity, ignore } = this.launch;
    this.ledgeId = null;
    this.ignoredLedge = ignore;
    this.velocity = { ...velocity };
    this.enter("fall");
    this.jumped = true;
    this.actor.play("jump_air");
  }

  // ---------------------------------------------------------------- 화면 밖에 나갔다 오기

  /** 가까운 화면 끝으로 걸어가 (가끔 두리번거린 뒤) 걸어 나간다 */
  private leaveScreen(arena: Arena): void {
    const middle = (arena.left + arena.right) / 2;
    const near: "left" | "right" = this.feet.x < middle ? "left" : "right";
    const side = this.random() < 0.8 ? near : near === "left" ? "right" : "left";
    this.sinceLeave = 0;
    const out = () => this.walkTo(this.offstageX(side, arena), arena, () => this.goAway(side), true);
    if (this.random() >= GLANCE_BEFORE_LEAVE) {
      out();
      return;
    }
    // 끝 가까이에서 멈춰 둘러본 다음 나간다
    const edge = side === "left" ? arena.left + this.margin() + this.actor.heightPx * 0.2 : arena.right - this.margin() - this.actor.heightPx * 0.2;
    this.walkTo(edge, arena, () => {
      this.targetFacing = 0;
      this.enter("act");
      this.actor.play("idle_look", out);
    });
  }

  private offstageX(side: "left" | "right", arena: Arena): number {
    const outside = this.actor.heightPx * OFFSTAGE;
    return side === "left" ? arena.left - outside : arena.right + outside;
  }

  private goAway(side: "left" | "right", seconds = AWAY_SECONDS.min + this.random() * (AWAY_SECONDS.max - AWAY_SECONDS.min)): void {
    this.awaySide = side;
    this.enter("away", seconds);
    this.actor.play("idle");
  }

  private updateAway(arena: Arena): void {
    if (this.paused || this.stateTime < this.stateLength) return;
    if (this.awayNext === "walkIn" || !this.options.variety) {
      this.walkIn(arena);
      return;
    }
    const pick = this.random();
    const other = this.awaySide === "left" ? "right" : "left";
    const side = this.random() < ENTER_OPPOSITE ? other : this.awaySide;
    const { peekIn, bigSide, bigUp } = RETURN_CHOICES;
    if (pick < peekIn) this.startPeek(side, arena, 1);
    else if (pick < peekIn + bigSide) this.startPeek(side, arena);
    else if (pick < peekIn + bigSide + bigUp) this.startPeek("up", arena);
    else this.walkIn(arena);
  }

  /**
   * 화면 밖 한쪽에서 걸어 들어온다 (정하지 않으면 주로 나간 반대쪽). 처음부터 걷는 방향을 보고 걷는 중이라 제자리에서 돌지 않는다.
   */
  private walkIn(arena: Arena, fromSide?: "left" | "right"): void {
    const opposite = this.awaySide === "left" ? "right" : "left";
    const side: "left" | "right" = fromSide ?? (this.random() < ENTER_OPPOSITE ? opposite : this.awaySide);
    const h = this.actor.heightPx;
    this.resetScale();
    this.teleported = true;
    this.ledgeId = null;
    this.roll = 0;
    this.feet = { x: this.offstageX(side, arena), y: arena.ground };
    this.awayNext = "return";
    const inside = h * (0.5 + this.random() * 1.5);
    const target = side === "left" ? arena.left + this.margin() + inside : arena.right - this.margin() - inside;
    this.walkTo(target, arena, () => this.toIdle(), true);
    this.facing = this.targetFacing = -this.walkDirection * WALK_FACING;
  }

  // ---------------------------------------------------------------- 크게 엿보기

  /**
   * 화면 가장자리에서 엿본다. 배율은 화면 밖에 있을 때 바꾼다 (보이는 채로 커지지 않게).
   * 옆: 발은 바닥, 몸은 화면 밖. 화면 쪽으로 천천히 기울여 머리·어깨만 들어온다.
   * 아래: 화면 맨 아래 밖에서 머리·어깨만 천천히 올라온다.
   * scale 1(보통 크기, 옆만)이면 둘러본 뒤 그쪽에서 걸어 들어온다. 크게 엿보면 숨은 뒤 잠시 있다가 걸어 들어온다.
   */
  private startPeek(kind: "left" | "right" | "up", arena: Arena, scale = PEEK.scale): void {
    const big = this.actor.heightPx * scale;
    this.displayScale = scale;
    this.teleported = true;
    this.ledgeId = null;
    this.roll = 0;
    this.rollVelocity = 0;
    let from: Point;
    let to: Point;
    if (kind === "up") {
      const bottom = arena.bottom ?? arena.ground;
      const x = arena.left + (arena.right - arena.left) * (0.2 + 0.6 * this.random());
      from = { x, y: bottom + big * PEEK.upHidden };
      to = { x, y: bottom + big * (1 - PEEK.upVisible) };
      this.targetFacing = 0;
    } else {
      const x = kind === "left" ? arena.left - big * PEEK.side : arena.right + big * PEEK.side;
      from = { x, y: arena.ground };
      to = from;
      // 얼굴이 정면으로 보이게: 몸을 화면 쪽으로 기울이면 얼굴이 안쪽으로 돌아가 보이므로 반대로 조금 돌려 맞춘다
      // (facing + = 화면 왼쪽을 봄. 안쪽을 보게 -0.35로 돌렸을 때는 얼굴 반쪽과 머리가 화면 끝에 잘렸다)
      this.targetFacing = kind === "left" ? PEEK.facing : -PEEK.facing;
    }
    this.facing = this.targetFacing;
    this.feet = { ...from };
    const small = scale === 1;
    const range = small ? PEEK_IN_HOLD : PEEK.hold;
    const hold = range.min + this.random() * (range.max - range.min);
    this.enter("peek");
    // 아래 엿보기는 화면 밖 깊이 숨었다 나오니 조금 길게 (숨은 구간은 빨리 지나가게 updatePeek에서 가감속을 바꾼다)
    const travel = kind === "up" ? 1.3 : 1;
    this.peekState = { kind, phase: "in", time: 0, hold, in: PEEK.in * travel, out: PEEK.out * travel, from, to, small };
    this.actor.play(kind === "up" ? "peek_up" : kind === "left" ? "peek_left" : "peek_right");
  }

  private updatePeek(dt: number, arena: Arena): void {
    const peek = this.peekState;
    if (!peek) {
      this.toIdle();
      return;
    }
    if (this.paused) return;
    peek.time += dt;
    const ease = (t: number) => t * t * (3 - 2 * t);
    // 아래 엿보기: 숨은 깊은 곳은 빨리 지나 보이는 곳에서 느려지고(올라오기), 보이는 곳에서 천천히 가라앉다가 빨라진다(내려가기)
    const up = peek.kind === "up";
    const easeIn = (t: number) => (up ? 1 - (1 - t) ** 3 : ease(t));
    const easeOut = (t: number) => (up ? t ** 3 : ease(t));
    if (peek.phase === "in") {
      const t = Math.min(1, peek.time / peek.in);
      this.peekPose(peek, easeIn(t), peek.time);
      if (t >= 1) {
        peek.phase = "hold";
        peek.time = 0;
      }
    } else if (peek.phase === "hold") {
      this.peekPose(peek, 1, peek.time + peek.in);
      if (peek.time >= peek.hold) {
        peek.phase = "out";
        peek.time = 0;
      }
    } else {
      const t = Math.min(1, peek.time / peek.out);
      this.peekPose(peek, 1 - easeOut(t), 0);
      if (t >= 1) {
        this.peekState = null;
        this.roll = 0;
        // 고개만 내밀었으면 바로 그쪽에서 걸어 들어온다 (둘러보고 들어오는 느낌)
        if (peek.small && peek.kind !== "up") {
          this.walkIn(arena, peek.kind);
          return;
        }
        // 크게 엿봤으면 화면 밖에서 잠깐 쉬었다가 보통 크기로 걸어 들어온다.
        // 쉬는 동안은 서 있는 자세로 바뀌므로, 숨은 자리(화면 아래·끝)에 큰 채로 두면 머리 끝이 삐져나온다 → 옆 화면 밖으로 옮겨 둔다.
        this.awayNext = "walkIn";
        const side = peek.kind === "up" ? (this.random() < 0.5 ? "left" : "right") : peek.kind;
        this.resetScale();
        this.feet = { x: this.offstageX(side, arena), y: arena.ground };
        this.goAway(side, AFTER_PEEK_SECONDS.min + this.random() * (AFTER_PEEK_SECONDS.max - AFTER_PEEK_SECONDS.min));
      }
    }
  }

  /** amount 0(숨음) ~ 1(다 나옴). 머무는 동안 아주 살짝 흔들린다 */
  private peekPose(peek: NonNullable<Behavior["peekState"]>, amount: number, time: number): void {
    const breathe = Math.sin(time * 1.6) * 0.04;
    if (peek.kind === "up") {
      this.feet.y = peek.from.y + (peek.to.y - peek.from.y) * amount;
      this.roll = Math.sin(time * 0.9) * 0.03 * amount;
      return;
    }
    const lean = peek.kind === "left" ? -PEEK.lean : PEEK.lean;
    this.roll = lean * amount * (1 + breathe);
  }

  /** 엿보기·화면 밖에서 크게 그리던 배율을 되돌린다 (순간이동으로 친다) */
  private resetScale(): void {
    this.peekState = null;
    if (this.displayScale !== 1) {
      this.displayScale = 1;
      this.teleported = true;
    }
  }

  private updateWalk(dt: number, arena: Arena): void {
    this.targetFacing = -this.walkDirection * WALK_FACING;
    // 멈추기: 걸음 중간에 바로 서면 앞뒤로 벌린 발이 서 있기 자세로 미끄러진다.
    // 두 발이 몸 아래에서 엇갈리는 순간까지 마저 걷고 멈춘다 (들린 발은 그대로 내려놓는다).
    if (this.stopping) {
      this.stopping.time += dt;
      if ((this.actor.canStopWalking?.() ?? true) || this.stopping.time >= STOP_WAIT_MAX) {
        const next = this.arrived;
        this.arrived = null;
        if (next) next();
        else this.toIdle();
        return;
      }
    }
    // 목표에 닿아 멈추는 중이면 화면 끝 판정을 하지 않는다. 화면 밖 목표에 닿은 뒤 발이 엇갈릴 때까지 기다리는 몇 프레임 동안
    // 목표가 비어 아래 끝 판정이 돌아, 화면 밖(-342)에 있던 몸을 화면 끝(102)으로 끌어당겼다 → 보이는 자리에서 사라져
    // 반대쪽에서 툭 튀어나왔다.
    if (this.arrived) return;
    // 정한 곳까지 걷기: 방향을 맞추고, 닿으면 발이 엇갈리는 순간 멈춘 뒤 이어서 할 일
    if (this.goal) {
      this.walkDirection = this.goal.x >= this.feet.x ? 1 : -1;
    }
    // 몸이 거의 돌아선 뒤에 출발 (돌면서 미끄러지지 않게)
    const turned = Math.abs(this.facing - this.targetFacing) < 0.25;
    if (turned && !this.stopping?.blocked) {
      // 몸을 돌린 만큼 다리 보폭의 화면 가로 성분이 줄어든다
      const speed = this.actor.walkSpeedPx * Math.sin(Math.abs(this.facing));
      this.feet.x += this.walkDirection * speed * dt;
    }
    if (this.goal) {
      const reached = this.walkDirection > 0 ? this.feet.x >= this.goal.x : this.feet.x <= this.goal.x;
      if (reached) {
        this.arrived = this.goal.then;
        this.goal = null;
        this.stopping = { time: 0, blocked: true };
      }
      if (reached || this.goalOffscreenWalk()) return;
    }
    const { left, right } = this.walkBounds(arena);
    // 끝을 향해 걷고 있을 때만 판정한다 (돌아서는 동안 매 프레임 다시 걸리지 않게)
    const atLeft = this.walkDirection < 0 && this.feet.x <= left;
    const atRight = this.walkDirection > 0 && this.feet.x >= right;
    if ((atLeft || atRight) && !this.steppingOff) {
      // 화면·창 끝: 창 위면 가끔 발을 헛디디고, 아니면 돌아서서 계속 걷거나 멈춘다
      const roll = this.random();
      // 화면 끝과 겹친 창 끝에서는 헛디디지 않는다 (화면 밖으로 떨어지지 않게)
      const margin = this.margin();
      const screenEdge = atRight ? this.feet.x >= arena.right - margin - 1 : this.feet.x <= arena.left + margin + 1;
      if (this.ledgeId !== null && roll < STEP_OFF_CHANCE && !screenEdge) {
        this.steppingOff = true;
        return;
      }
      this.feet.x = clamp(this.feet.x, left, right);
      if (roll < 0.6) {
        this.walkDirection = atLeft ? 1 : -1;
      } else {
        this.stopping = { time: 0, blocked: true };
        return;
      }
    }
    if (!this.paused && !this.stopping && this.stateTime >= this.stateLength) this.stopping = { time: 0, blocked: false };
  }

  /** 화면 밖으로(또는 밖에서) 걷는 중이면 화면 끝 판정을 하지 않는다 */
  private goalOffscreenWalk(): boolean {
    return this.goal?.offscreen ?? false;
  }

  private updateHeld(dt: number): void {
    // 커서를 바로 따라가되 한 프레임 튀는 값은 조금 눌러 준다 (물리 폭주 방지)
    const previous = { ...this.held };
    this.held.x = damp(this.held.x, this.pointer.x, 0.025, dt);
    this.held.y = damp(this.held.y, this.pointer.y, 0.025, dt);
    const vx = dt > 0 ? (this.held.x - previous.x) / dt : 0;

    // 진자: 끄는 방향 반대로 발이 처진다. 회전 중심은 잡은 점.
    // 프레임 간격이 ±10%만 들쭉날쭉해도 한 프레임 속도로 만든 목표가 튀어 기울기가 떨렸다 (3차 차분 12배).
    // 목표를 tanh로 눌러 거르고, 진자는 고정 간격으로 나눠 적분한다.
    const omega = 2 * Math.PI * SWAY_HZ;
    const raw = -vx * SWAY_PER_SPEED;
    this.swayTarget = damp(this.swayTarget, SWAY_TARGET_MAX * Math.tanh(raw / SWAY_TARGET_MAX), SWAY_TARGET_SMOOTH, dt);
    const steps = Math.max(1, Math.ceil(dt / SWAY_STEP));
    const h = dt / steps;
    for (let step = 0; step < steps; step++) {
      let acceleration = -omega * omega * (this.roll - this.swayTarget) - 2 * SWAY_DAMPING * omega * this.rollVelocity;
      // 한계 근처에서는 단단한 스프링으로 밀어낸다 (딱 멈추는 대신)
      const over = Math.abs(this.roll) - SWAY_MAX * 0.9;
      if (over > 0) acceleration -= Math.sign(this.roll) * over * omega * omega * 8;
      this.rollVelocity += acceleration * h;
      this.roll += this.rollVelocity * h;
    }
    this.roll = clamp(this.roll, -SWAY_MAX, SWAY_MAX);

    const rotated = rotateCss(this.grabOffset, this.roll);
    this.feet = { x: this.held.x + rotated.x, y: this.held.y + rotated.y };

    // 오래 들고 있거나 세게 흔들면 버둥거린다
    this.heldTime += dt;
    const vy = dt > 0 ? (this.held.y - previous.y) / dt : 0;
    this.shake = damp(this.shake, Math.hypot(vx, vy), 0.3, dt);
    const wants = this.heldTime >= STRUGGLE_AFTER || this.shake >= STRUGGLE_SHAKE;
    if (this.struggling) this.struggleTime += dt;
    if (wants && !this.struggling) {
      this.struggling = true;
      this.struggleTime = 0;
      this.actor.play("hang_struggle");
    } else if (!wants && this.struggling && this.struggleTime >= STRUGGLE_MIN) {
      this.struggling = false;
      this.actor.play("hang");
    }
  }

  private updateFall(dt: number, arena: Arena): void {
    const previousY = this.feet.y;
    this.velocity.y += GRAVITY * dt;
    this.feet.x += this.velocity.x * dt;
    this.feet.y += this.velocity.y * dt;
    this.roll = damp(this.roll, 0, 0.18, dt);

    const margin = this.margin();
    // 옆 모니터가 있는 쪽으로 날아가면 튕기지 않는다 (무대가 화면 끝을 넘을 때 그 모니터로 옮긴다)
    const pastLeft = this.feet.x < arena.left + margin && !(arena.openLeft && this.velocity.x < 0);
    const pastRight = this.feet.x > arena.right - margin && !(arena.openRight && this.velocity.x > 0);
    if (pastLeft || pastRight) {
      this.feet.x = clamp(this.feet.x, arena.left + margin, arena.right - margin);
      this.velocity.x = -this.velocity.x * WALL_BOUNCE;
    }
    // 머리가 화면 위로 나가지 않게
    const topLimit = arena.top + this.actor.heightPx * 1.15;
    if (this.feet.y < topLimit && this.velocity.y < 0) {
      this.feet.y = topLimit;
      this.velocity.y = 0;
    }
    // 위에서 아래로 지난 테두리 중 가장 먼저 지난(가장 높은) 것에 착지
    let landing: Ledge | null = null;
    if (this.velocity.y > 0) {
      for (const ledge of arena.ledges ?? []) {
        const crossed = previousY <= ledge.y + 0.5 && this.feet.y >= ledge.y;
        const over = this.feet.x >= ledge.left && this.feet.x <= ledge.right;
        if (ledge.id === this.ignoredLedge) continue;
        if (crossed && over && (!landing || ledge.y < landing.y)) landing = ledge;
      }
    }
    if (landing || this.feet.y >= arena.ground) {
      const impact = this.velocity.y;
      if (landing) {
        this.standOn(landing);
      } else {
        this.feet.y = arena.ground;
        this.ledgeId = null;
        this.ignoredLedge = null;
      }
      this.velocity = { x: 0, y: 0 };
      // 스스로 뛰었으면 살짝 내려앉아도 착지 모션 (무릎으로 받는다)
      const jumped = this.jumped;
      this.jumped = false;
      if (impact >= LAND_IMPACT || jumped) {
        this.enter("land");
        this.actor.play("land", () => this.toIdle());
      } else {
        this.toIdle();
      }
    }
  }

  private toIdle(): void {
    this.targetFacing = 0;
    this.enter("idle", 4 + this.random() * 6);
    this.actor.play("idle");
  }

  /** 그 자리에 앉는다 (창 위면 걸터앉기, 바닥이면 다리 뻗고). sleepy면 존다. */
  /**
   * 그 자리에 앉는다 (창 위면 걸터앉기, 바닥이면 다리 뻗고). sleepy면 존다.
   * 서 있었으면 앉는 모션(sit_down_*)을 먼저 하고, 이미 앉아 있으면 바로 반복 모션으로 바꾼다.
   */
  private sit(sleepy: boolean): void {
    // 정면 카메라라 정면으로 앉으면 무릎이 화면 쪽을 향해 다리가 짧아 보인다. 걷던 쪽으로 살짝 돌아앉는다.
    this.targetFacing = -this.walkDirection * SIT_FACING;
    const seat = this.ledgeId !== null ? "edge" : "floor";
    const loop = `${sleepy ? "sleep" : "sit"}_${seat}`;
    const alreadySeated = this.state === "sit" || this.state === "sleep";
    if (sleepy) this.enter("sleep");
    else this.enter("sit", SIT_SECONDS.min + this.random() * (SIT_SECONDS.max - SIT_SECONDS.min));
    if (alreadySeated) {
      this.actor.play(loop);
      return;
    }
    this.seatMoving = true;
    // 먼저 앉을 방향으로 돌아선 뒤 앉기 시작한다 (update에서 다 돌았는지 본다)
    this.pendingSit = { motion: `sit_down_${seat}`, loop };
    this.beginSitDownWhenTurned();
  }

  private beginSitDownWhenTurned(): void {
    const pending = this.pendingSit;
    if (!pending || Math.abs(this.facing - this.targetFacing) > 0.08) return;
    this.pendingSit = null;
    this.actor.play(pending.motion, () => {
      this.seatMoving = false;
      if (this.state === "sit" || this.state === "sleep") this.actor.play(pending.loop);
    });
  }

  /** 앉은 채 쓰다듬기 반응 (sit_pat_*). 앉는·일어서는 중이면 무시. 끝나면 앉기 반복으로 돌아가고, 앉아 있는 시간은 조금 늘린다. */
  private patSeated(seat: "edge" | "floor"): void {
    if (this.state === "rise" || this.seatMoving || this.pendingSit) return;
    if (this.state === "sleep") {
      this.enter("sit", SIT_SECONDS.min + this.random() * (SIT_SECONDS.max - SIT_SECONDS.min));
    } else {
      this.stateLength = Math.max(this.stateLength, this.stateTime + SIT_SECONDS.min / 2);
    }
    this.seatMoving = true;
    this.actor.play(`sit_pat_${seat}`, () => {
      this.seatMoving = false;
      if (this.state === "sit") this.actor.play(`sit_${seat}`);
    });
  }

  /** 앉은 자리에서 일어선다 (stand_up_*). 끝나면 서 있기, 클릭으로 일어났으면 그 반응을 이어서 한다. */
  private rise(reaction?: "pat" | "poke"): void {
    const seat = this.seat ?? "floor";
    this.enter("rise");
    this.riseSeat = seat;
    // 일어서는 동안은 앉은 각도 그대로 (다 서면 toIdle이 정면으로)
    this.actor.play(`stand_up_${seat}`, () => {
      if (this.state !== "rise") return;
      if (reaction) {
        this.enter("react");
        this.actor.play(reaction, () => this.toIdle());
      } else {
        this.toIdle();
      }
    });
  }

  // ---------------------------------------------------------------- 창 발판

  /**
   * 창 위치를 매끄럽게 따라간다. 창 위치는 폴링 간격(8ms)과 창이 실제로 움직이는 간격(보통 화면 주사율)이
   * 렌더 프레임과 맞지 않아, 그대로 쓰면 어떤 프레임은 두 칸, 어떤 프레임은 0칸 움직여 뚝뚝 끊겨 보인다.
   * 샘플 사이 간격으로 창 속도를 어림해 그 속도로 움직이고, 남는 오차는 40ms 반감기로 메운다.
   * 일정한 속도면 거의 늦지 않는다. 크게 튀면(창 스냅·화면 전환) 바로 옮긴다.
   */
  private followWindow(raw: Point, dx: number, dy: number, dt: number): void {
    this.ledgeSampleAge += dt;
    if (dx !== 0 || dy !== 0) {
      // 가만히 있던 창의 첫 변화로는 속도를 알 수 없다 (한 번에 옮긴 것일 수도 있다). 둘째 샘플부터 어림한다.
      if (this.ledgeSampleAge <= FOLLOW_STOP_AFTER) {
        const span = Math.max(this.ledgeSampleAge, 1 / 240);
        const limit = (value: number) => clamp(value, -FOLLOW_MAX_SPEED, FOLLOW_MAX_SPEED);
        this.ledgeEstimate = {
          x: this.ledgeEstimate.x * 0.5 + limit(dx / span) * 0.5,
          y: this.ledgeEstimate.y * 0.5 + limit(dy / span) * 0.5,
        };
      }
      this.ledgeSampleAge = 0;
    } else if (this.ledgeSampleAge > FOLLOW_STOP_AFTER) {
      // 한동안 안 바뀌었으면 멈춘 것: 어림 속도를 빠르게 줄인다
      const keep = Math.pow(0.5, dt / 0.03);
      this.ledgeEstimate = { x: this.ledgeEstimate.x * keep, y: this.ledgeEstimate.y * keep };
    }
    const ahead = Math.min(this.ledgeSampleAge, FOLLOW_STOP_AFTER);
    const predicted = { x: raw.x + this.ledgeEstimate.x * ahead, y: raw.y + this.ledgeEstimate.y * ahead };
    const previous = { ...this.ledgeShown };
    if (Math.hypot(predicted.x - this.ledgeShown.x, predicted.y - this.ledgeShown.y) > this.actor.heightPx * 0.5) {
      this.ledgeShown = predicted;
    } else {
      const catchUp = 1 - Math.pow(0.5, dt / FOLLOW_CATCH_UP);
      this.ledgeShown = {
        x: this.ledgeShown.x + this.ledgeEstimate.x * dt,
        y: this.ledgeShown.y + this.ledgeEstimate.y * dt,
      };
      this.ledgeShown.x += (predicted.x - this.ledgeShown.x) * catchUp;
      this.ledgeShown.y += (predicted.y - this.ledgeShown.y) * catchUp;
    }
    this.feet.x += this.ledgeShown.x - previous.x;
    this.feet.y = this.ledgeShown.y;
  }

  private standOn(ledge: Ledge): void {
    this.ledgeId = ledge.id;
    this.ignoredLedge = null;
    this.ledgeAnchor = { x: ledge.windowX, y: ledge.y };
    this.ledgeShown = { x: ledge.windowX, y: ledge.y };
    this.ledgeEstimate = { x: 0, y: 0 };
    this.ledgeSampleAge = Number.POSITIVE_INFINITY;
    this.ledgeSpeed = 0;
    this.ledgeVelocity = { x: 0, y: 0 };
    this.feet.y = ledge.y;
  }

  /** 창이 움직이면 따라가고, 사라지거나 세게 흔들리거나 발이 끝을 벗어나면 떨어진다. */
  private followLedge(dt: number, arena: Arena): void {
    const segments = (arena.ledges ?? []).filter((ledge) => ledge.id === this.ledgeId);
    if (segments.length === 0) {
      this.drop({ x: 0, y: 0 });
      return;
    }
    const raw: Point = { x: segments[0].windowX, y: segments[0].y };
    const dx = raw.x - this.ledgeAnchor.x;
    const dy = raw.y - this.ledgeAnchor.y;
    this.ledgeAnchor = raw;
    this.followWindow(raw, dx, dy, dt);

    // 창 위치는 폴링 주기(30Hz)마다 계단식으로 바뀐다. 프레임마다의 순간 속도를 시간 가중
    // 지수 평균하면 프레임 수와 상관없이 실제 평균 속력이 된다.
    if (dt > 0) {
      const keep = Math.exp(-dt / SHAKE_WINDOW);
      const take = 1 - keep;
      this.ledgeSpeed = this.ledgeSpeed * keep + (Math.hypot(dx, dy) / dt) * take;
      this.ledgeVelocity = {
        x: this.ledgeVelocity.x * keep + (dx / dt) * take,
        y: this.ledgeVelocity.y * keep + (dy / dt) * take,
      };
    }
    if (this.ledgeSpeed > SHAKE_SPEED) {
      // 흔들리는 방향으로 튕겨 나간다 (아래로는 물려받지 않음: 창 속으로 박히지 않게)
      this.drop({
        x: this.ledgeVelocity.x * SHAKE_CARRY,
        y: Math.min(0, this.ledgeVelocity.y * SHAKE_CARRY) - SHAKE_HOP,
      });
      return;
    }

    const slack = this.actor.heightPx * 0.04;
    const standing = segments.some((ledge) => this.feet.x >= ledge.left - slack && this.feet.x <= ledge.right + slack);
    if (!standing) {
      const carry = this.state === "walk" ? this.walkDirection * this.actor.walkSpeedPx * 0.5 : 0;
      this.drop({ x: carry, y: 0 });
    }
  }

  private drop(velocity: Point): void {
    this.ignoredLedge = this.ledgeId;
    this.ledgeId = null;
    this.velocity = { ...velocity };
    this.targetFacing = 0;
    this.enter("fall");
    this.actor.play("fall");
  }

  /** 걸을 수 있는 가로 범위: 바닥이면 화면, 창 위면 발이 놓인 보이는 구간 */
  private walkBounds(arena: Arena): { left: number; right: number } {
    const margin = this.margin();
    let left = arena.left + margin;
    let right = arena.right - margin;
    if (this.ledgeId !== null) {
      const edge = this.actor.heightPx * 0.12;
      const segment = arena.ledges?.find(
        (ledge) => ledge.id === this.ledgeId && this.feet.x >= ledge.left - edge && this.feet.x <= ledge.right + edge,
      );
      if (segment) {
        left = Math.max(left, segment.left + edge);
        right = Math.min(right, segment.right - edge);
      }
    }
    return { left, right: Math.max(left, right) };
  }

  private enter(state: BehaviorState, length = 0): void {
    this.steppingOff = false;
    this.stopping = null;
    // 이어서 할 일은 상태를 바꿀 때마다 버린다 (잡히거나 떨어지면 계획이 끝난다). 필요하면 enter 뒤에 다시 정한다.
    this.goal = null;
    this.launch = null;
    this.pendingSit = null;
    if (state !== "walk") this.arrived = null;
    if (state !== "peek") this.peekState = null;
    // 앉는 도중 잡히거나 떨어지면 콜백이 안 오므로 상태가 바뀔 때마다 푼다 (sit()은 enter 뒤에 다시 켠다)
    this.seatMoving = false;
    this.state = state;
    this.stateTime = 0;
    this.stateLength = length;
  }

  /** 화면 끝 여백: 몸 절반 정도 */
  private margin(): number {
    return this.actor.heightPx * 0.3;
  }
}

/** CSS 좌표(y 아래)에서 화면 반시계 방향으로 회전 */
export function rotateCss(point: Point, angle: number): Point {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: point.x * cos + point.y * sin, y: -point.x * sin + point.y * cos };
}
