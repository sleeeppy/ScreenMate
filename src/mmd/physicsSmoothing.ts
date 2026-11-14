/**
 * 물리 뼈 떨림 거르기 (치마·머리카락·리본).
 *
 * Sour 린 치마는 가벼운 상자 강체 112개(질량 0.01~0.1)를 ±1° 조인트 224개로 묶고, 일부가 다리 강체에 기대어 있다.
 * 서 있기만 해도 솔버가 조인트 한계·다리 접촉을 맞추느라 매 프레임 1~6px씩 떨렸다 (물리를 끄면 0.01px).
 * 물리 값을 바꾸면(다리 충돌 끄기·조인트 한계 풀기) 떨림은 사라지지만 치마 모양이 무너져서, 물리는 그대로 두고
 * 그린 결과만 거른다.
 *
 * - 물리가 움직이는 뼈와 그 아래 뼈만, 매달린 몸(물리가 아닌 가장 가까운 조상: 치마는 下半身, 머리카락은 頭)에 대한
 *   상대 변환을 거른다. 몸 전체가 걷거나 끌려 다니는 움직임은 늦어지지 않는다.
 * - One Euro 필터: 움직임이 작을 때(떨림)는 세게, 클 때(걷기 흔들림·흔들어 펄럭임)는 거의 그대로 따라간다.
 * - babylon-mmd가 물리 뒤 뼈 최종 행렬(worldTransformMatrices)을 onBeforeRender에서 채우고, 스키닝은 그 직후 그릴 때 읽는다.
 *   그 사이에 고쳐 쓴다. 물리 계산 자체는 건드리지 않는다.
 */
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";

export { physicsBoneAnchors } from "./physicsBones.ts";

/**
 * 떨림 수준에서의 차단 주파수 (Hz). 낮을수록 세게 거른다.
 * 빠르기에 따라 차단 주파수를 올리는 정도 (위치: 모델 단위/초당, 회전: 라디안/초당). 클수록 움직일 때 덜 늦다.
 * Sour 린 Black, 키 340px, 30fps에서 잰 값 (치마 뼈 128개, 프레임 간 2차 차분):
 *   서 있기 떨림 평균/상위 5%/최대 0.40/1.27/4.9px → 0.06/0.19/1.0px,
 *   걸을 때 물리 위치와의 차이 평균 0.6px(최대 4.4), 들고 흔들 때 평균 0.8px(최대 4.2).
 *   차단 1.2Hz·β 0.8/0.5는 떨림이 2배 남았고, β 0.4/0.25는 흔들 때 최대 10px 늦었다.
 */
const MIN_CUTOFF = 0.5;
const BETA_POSITION = 1.5;
const BETA_ROTATION = 1.0;
/** 빠르기 추정을 거르는 주파수 (Hz) */
const DERIVATIVE_CUTOFF = 1.0;

function smoothingFactor(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

/** 뼈 하나의 One Euro 필터 상태 (기준 뼈에 대한 상대 위치·회전) */
class BoneFilter {
  position = new Vector3();
  rotation = new Quaternion();
  positionSpeed = 0;
  rotationSpeed = 0;
  ready = false;

  update(position: Vector3, rotation: Quaternion, dt: number): void {
    if (!this.ready) {
      this.position.copyFrom(position);
      this.rotation.copyFrom(rotation);
      this.positionSpeed = 0;
      this.rotationSpeed = 0;
      this.ready = true;
      return;
    }
    const derivative = smoothingFactor(DERIVATIVE_CUTOFF, dt);
    const speed = Vector3.Distance(position, this.position) / dt;
    this.positionSpeed += (speed - this.positionSpeed) * derivative;
    const positionFactor = smoothingFactor(MIN_CUTOFF + BETA_POSITION * this.positionSpeed, dt);
    Vector3.LerpToRef(this.position, position, positionFactor, this.position);

    const dot = Math.min(1, Math.abs(Quaternion.Dot(this.rotation, rotation)));
    const angularSpeed = (2 * Math.acos(dot)) / dt;
    this.rotationSpeed += (angularSpeed - this.rotationSpeed) * derivative;
    const rotationFactor = smoothingFactor(MIN_CUTOFF + BETA_ROTATION * this.rotationSpeed, dt);
    Quaternion.SlerpToRef(this.rotation, rotation, rotationFactor, this.rotation);
  }
}

interface RuntimeBoneLike {
  readonly worldMatrix: Float32Array;
}

/** 모델 하나의 물리 뼈 떨림 거르기. 매 프레임 물리 뒤·그리기 전에 apply */
export class PhysicsSmoother {
  private readonly entries: { bone: RuntimeBoneLike; anchor: RuntimeBoneLike; filter: BoneFilter }[];
  private readonly world = new Matrix();
  private readonly anchorWorld = new Matrix();
  private readonly anchorInverse = new Matrix();
  private readonly relative = new Matrix();
  private readonly scale = new Vector3();
  private readonly rotation = new Quaternion();
  private readonly position = new Vector3();

  constructor(bones: readonly RuntimeBoneLike[], anchors: Map<number, number>) {
    this.entries = [...anchors].map(([index, anchor]) => ({ bone: bones[index], anchor: bones[anchor], filter: new BoneFilter() }));
  }

  get size(): number {
    return this.entries.length;
  }

  /** 순간이동·물리 다시 놓기 뒤에는 지난 값을 버린다 (예전 자리로 끌려오지 않게) */
  reset(): void {
    for (const entry of this.entries) entry.filter.ready = false;
  }

  /** dt: 지난 그리기 뒤 흐른 시간 (초) */
  apply(dt: number): void {
    if (!(dt > 0) || dt > 0.25) {
      // 숨김에서 돌아오는 등 오래 멈췄다 그리면 거르지 않고 지금 값에서 다시 시작
      this.reset();
    }
    const step = Math.min(Math.max(dt, 1 / 240), 0.25);
    for (const { bone, anchor, filter } of this.entries) {
      Matrix.FromArrayToRef(anchor.worldMatrix, 0, this.anchorWorld);
      this.anchorWorld.invertToRef(this.anchorInverse);
      Matrix.FromArrayToRef(bone.worldMatrix, 0, this.world);
      // 행 벡터 규약: world = relative × anchorWorld
      this.world.multiplyToRef(this.anchorInverse, this.relative);
      this.relative.decompose(this.scale, this.rotation, this.position);
      filter.update(this.position, this.rotation, step);
      Matrix.ComposeToRef(this.scale, filter.rotation, filter.position, this.relative);
      this.relative.multiplyToRef(this.anchorWorld, this.world);
      this.world.copyToArray(bone.worldMatrix, 0);
    }
  }
}
