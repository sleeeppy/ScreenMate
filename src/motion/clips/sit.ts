import { defineMotion, k, type Key, type KeyValues, type Motion } from "../dsl.ts";
import { splinePose } from "../spline.ts";
import { ARM_FORWARD, ARM_RELAX, ELBOW_RELAX } from "./pose.ts";

/**
 * 앉기와 앉고 일어서기 (다리 IK 끔).
 *
 * 발 기준점(행동의 feet)은 앉은 면(창 테두리·바닥)에 있고, 센터를 엉덩이 높이만큼 내려 엉덩이가 그 면에 닿게 한다.
 * 엉덩이(足) 기본 높이는 발목 1.1 + 다리 9.3 ≈ 10.4, 엉덩이 두께 0.9를 남긴다.
 * (센터 이동은 모델 다리 길이 비율 legScale이 곱해지므로 모델마다 맞는다.)
 *
 * - edge: 창 위쪽 테두리에 걸터앉아 다리를 앞으로 내밀고 종아리를 아래로 늘어뜨린다. 다리를 번갈아 흔든다.
 * - floor: 바닥에 다리를 쭉 뻗고 앉아(장좌) 팔을 뒤로 짚는다.
 * - sleepy: 고개를 꾸벅이며 눈을 감는다 (졸기). 다리 흔들기는 멈춘다.
 *
 * 앉는·일어서는 전환은 같은 자세 표(STAND·CROUCH·seatPose …)를 매끄러운 곡선(spline.ts)으로 잇는다.
 * 준비(무게 싣기) → 본동작 → 안착(살짝 내려앉았다 자리 잡기) 순서이고, 상체가 먼저·머리와 팔이 늦게 따라온다.
 * 전환 끝 자세 = 반복 첫 프레임이라 전환 → 반복이 이음매 없이 이어진다. 다리 IK를 끄므로 쪼그리기는 허벅지·종아리 각도로 발이 엉덩이 아래에 오게 잡았다
 * (허벅지 앞 50°, 무릎 100° → 종아리 뒤 50°: 높이 4.6cos50 + 4.7cos50 ≈ 6.0 = 다리 9.3 - 센터 3.4).
 */
export const SIT_DROP = 9.5;
/** 앉았을 때 머리 꼭대기 높이 / 선 키 (클릭 판정·시선용, 대략) */
export const SIT_HEAD_RATIO = 0.42;
const LENGTH = 90;

/** 다리 길이 (모델 단위): 허벅지, 종아리, 발목~바닥. 엉덩이 기본 높이 = 1.1 + 4.6 + 4.7 ≈ 10.4 */
const THIGH = 4.6;
const SHIN = 4.7;
const ANKLE = 1.1;
const HIP = ANKLE + THIGH + SHIN;

/**
 * 센터를 drop만큼 내렸을 때 발바닥이 바닥에 평평하게 닿는 다리 (다리 IK를 끄므로 직접 맞춘다).
 * thigh: 허벅지가 수직에서 앞으로 든 각(도, 90 넘으면 무릎이 엉덩이보다 높음).
 * feetBehind: 종아리가 뒤로 기울어 발이 엉덩이 아래(쪼그리기), 아니면 앞으로 기울어 발이 앞(앉아서 무릎 세우기).
 * 예전에는 각을 눈대중으로 정해 엉덩이를 내리는 동안 발이 바닥 아래로 2~4 단위 꺼졌다 (일어선 것처럼 보임).
 */
function legsOnFloor(drop: number, thigh: number, feetBehind: boolean): Pose {
  const reach = (HIP - drop - ANKLE - THIGH * Math.cos((thigh * Math.PI) / 180)) / SHIN;
  const shin = ((feetBehind ? -1 : 1) * Math.acos(Math.max(-1, Math.min(1, reach))) * 180) / Math.PI;
  const knee = -(thigh - shin);
  return {
    左足: { rx: thigh, rz: -4 },
    右足: { rx: thigh, rz: 4 },
    左ひざ: { rx: knee },
    右ひざ: { rx: knee },
    左足首: { rx: -shin },
    右足首: { rx: -shin },
  };
}

type Pose = Record<string, KeyValues>;
type Seat = "edge" | "floor";

/**
 * 발바닥을 앉은 면 위 한 점에 딛게 하는 다리 (옆에서 본 2관절 IK, 무릎은 앞으로 굽는다).
 * drop: 센터를 내린 만큼, forward: 엉덩이에서 발목까지 앞쪽 거리(음수면 뒤).
 * 엉덩이를 뒤로 빼며 앉거나 일어서는 동안 발이 미끄러지지 않게, 자세마다 발 자리를 정해 각도를 구한다.
 */
function legsIk(drop: number, forward: number): Pose {
  const down = HIP - drop - ANKLE;
  const reach = Math.min(Math.hypot(forward, down), THIGH + SHIN - 0.01);
  const toFoot = Math.atan2(forward, down);
  const bend = Math.acos(Math.max(-1, Math.min(1, (THIGH * THIGH + reach * reach - SHIN * SHIN) / (2 * THIGH * reach))));
  const thighRad = toFoot + bend;
  const kneeX = THIGH * Math.sin(thighRad);
  const kneeDown = THIGH * Math.cos(thighRad);
  const shinRad = Math.atan2(forward - kneeX, down - kneeDown);
  const deg = (rad: number) => (rad * 180) / Math.PI;
  const thigh = deg(thighRad);
  const shin = deg(shinRad);
  return {
    左足: { rx: thigh, rz: -4 },
    右足: { rx: thigh, rz: 4 },
    左ひざ: { rx: -(thigh - shin) },
    右ひざ: { rx: -(thigh - shin) },
    左足首: { rx: -shin },
    右足首: { rx: -shin },
  };
}

/**
 * 걸터앉을 때 엉덩이를 뒤로 빼는 거리 (센터 Z+, 모델 단위). 사람은 쪼그렸다가 엉덩이를 뒤로 내려 앉는다.
 * 무릎을 세우고 앉은 순간 발은 엉덩이 앞 8.8쯤(허벅지 110°)에 있어야 해서, 엉덩이를 6.5 빼면 발은 처음 자리에서 2.3만 앞으로 옮긴다.
 * (발을 더 가까이 두면 무릎이 가슴까지 올라와 정면에서 치마 속이 보였다.)
 * 예전에는 엉덩이를 제자리에 내리며 다리를 바로 늘어뜨려, 엉덩이가 아직 높은데 다리가 허공에 곧게 서 있었다.
 */
const EDGE_BACK = 3.5;
/** 무릎을 세우고 걸터앉았을 때 발 자리 (처음 선 자리에서 앞으로) */
const EDGE_FEET = 5.3;

/**
 * 선 자세 (idle 0프레임 + 다리 IK가 KNEE_SOFT 0.1만큼 굽힌 다리). 전환 시작·끝.
 * 허벅지 앞 8°, 무릎 17°, 발목은 발바닥이 평평하게 되돌린다.
 */
const STAND: Pose = {
  センター: { py: 0 },
  上半身: {},
  首: { rx: -1.5 },
  左腕: { rz: -ARM_RELAX, rx: ARM_FORWARD },
  右腕: { rz: ARM_RELAX, rx: ARM_FORWARD },
  左ひじ: { ry: ELBOW_RELAX },
  右ひじ: { ry: -ELBOW_RELAX },
  左足: { rx: 8 },
  右足: { rx: 8 },
  左ひざ: { rx: -17 },
  右ひざ: { rx: -17 },
  左足首: { rx: 9 },
  右足首: { rx: 9 },
};

/** 쪼그리기: 발은 그대로 엉덩이 아래, 상체를 숙이고 팔을 앞으로 내밀어 균형 */
const CROUCH: Pose = {
  センター: { py: -3.4 },
  上半身: { rx: -20 },
  首: { rx: 8 },
  左腕: { rz: -ARM_RELAX + 8, rx: 38 },
  右腕: { rz: ARM_RELAX - 8, rx: 38 },
  左ひじ: { ry: ELBOW_RELAX + 14 },
  右ひじ: { ry: -ELBOW_RELAX - 14 },
  左足: { rx: 50, rz: -3 },
  右足: { rx: 50, rz: 3 },
  左ひざ: { rx: -100 },
  右ひざ: { rx: -100 },
  左足首: { rx: 50 },
  右足首: { rx: 50 },
};

/** 앉은 자세 (반복 0프레임) */
function seatPose(place: Seat, sleepy: boolean): Pose {
  const edge = place === "edge";
  const armDown = edge ? (sleepy ? 4 : 8) : 6;
  const armForward = edge ? (sleepy ? 34 : ARM_FORWARD + 10) : -28;
  const elbow = sleepy && edge ? 38 : ELBOW_RELAX - 4;
  return {
    センター: edge ? { py: -SIT_DROP, pz: EDGE_BACK } : { py: -SIT_DROP },
    上半身: sleepy ? { rx: -9 } : edge ? { rx: -2, ry: 2 } : { rx: 9 },
    首: sleepy ? { rx: -16, rz: 5 } : edge ? { rx: -3, rz: 3 } : { rx: -6 },
    左腕: { rz: -ARM_RELAX - armDown, rx: armForward },
    右腕: { rz: ARM_RELAX + armDown, rx: armForward },
    左ひじ: { ry: elbow },
    右ひじ: { ry: -elbow },
    // 허벅지는 앞으로 수평 (足 X+ = 앞)
    左足: { rx: 86, rz: -3 },
    右足: { rx: 86, rz: 3 },
    // 걸터앉으면 무릎을 굽혀 종아리를 아래로, 바닥이면 쭉 편다 (ひざ X- = 굽힘). 오른쪽은 반 주기 어긋나게 흔든다.
    左ひざ: { rx: edge ? (sleepy ? -88 : -102) : -6 },
    右ひざ: { rx: edge ? (sleepy ? -92 : -70) : -6 },
    左足首: { rx: edge ? -14 : 12 },
    右足首: { rx: edge ? -10 : 12 },
  };
}

/** 반복 반 주기(45프레임) 자세: 앉은 자세에서 흔들리는 본만 바꾼다 */
function seatSwing(place: Seat, sleepy: boolean): Pose {
  const base = seatPose(place, sleepy);
  if (sleepy) return { ...base, 上半身: { rx: -11 } };
  if (place === "edge") {
    return {
      ...base,
      上半身: { rx: -3, ry: -2 },
      首: { rx: -2, rz: -3 },
      左ひざ: { rx: -70 },
      右ひざ: { rx: -102 },
    };
  }
  return { ...base, 上半身: { rx: 8 }, 首: { rx: -5, rz: 2 } };
}

/** 자세 표들을 프레임에 맞춰 이어 붙인다. 모든 자세에 나오는 본만 트랙이 된다. */
function sequence(steps: readonly { frame: number; pose: Pose }[]): Record<string, Key[]> {
  const bones = Object.keys(steps[0].pose).filter((bone) => steps.every((step) => bone in step.pose));
  return Object.fromEntries(bones.map((bone) => [bone, steps.map((step) => k(step.frame, step.pose[bone]))]));
}

function seatLoop(name: string, label: string, place: Seat, sleepy: boolean): Motion {
  const a = seatPose(place, sleepy);
  const b = seatSwing(place, sleepy);
  const bones = sequence([
    { frame: 0, pose: a },
    { frame: LENGTH / 2, pose: b },
    { frame: LENGTH, pose: a },
  ]);
  if (sleepy) {
    // 꾸벅: 천천히 숙였다가 퍼뜩 조금 든다
    bones.首 = [k(0, { rx: -16, rz: 5 }), k(55, { rx: -27, rz: 7, ease: "in" }), k(64, { rx: -15, rz: 4, ease: "snap" }), k(LENGTH, { rx: -16, rz: 5 })];
  }
  return defineMotion({
    name,
    label,
    loop: true,
    length: LENGTH,
    fadeIn: 0.5,
    legIk: false,
    bones,
    morphs: sleepy
      ? { blink: [k(0, { w: 1 }), k(LENGTH, { w: 1 })], sleepy: [k(0, { w: 0.5 }), k(LENGTH, { w: 0.5 })] }
      : { smile: [k(0, { w: 0.25 }), k(LENGTH, { w: 0.25 })] },
  });
}

/** 움직이기 직전 준비: 살짝 내려다보며 무게를 싣는다 */
const PREPARE: Pose = {
  ...STAND,
  センター: { py: -0.5 },
  上半身: { rx: -6 },
  首: { rx: -7 },
  左腕: { rz: -ARM_RELAX + 2, rx: ARM_FORWARD + 10 },
  右腕: { rz: ARM_RELAX - 2, rx: ARM_FORWARD + 10 },
  左足: { rx: 14 },
  右足: { rx: 14 },
  左ひざ: { rx: -28 },
  右ひざ: { rx: -28 },
  左足首: { rx: 14 },
  右足首: { rx: 14 },
};

/** 바닥에 앉을 때 쪼그린 다음: 손을 뒤로 짚고 엉덩이를 내린다 (무릎은 아직 굽힌 채) */
const FLOOR_LOWER: Pose = {
  ...CROUCH,
  センター: { py: -8.4 },
  上半身: { rx: 0 },
  首: { rx: -2 },
  左腕: { rz: -ARM_RELAX - 6, rx: -22 },
  右腕: { rz: ARM_RELAX + 6, rx: -22 },
  ...legsOnFloor(8.4, 112, false),
};

/** 엉덩이가 바닥에 닿은 뒤: 무릎을 세운 채 살짝 내려앉았다가 다리를 뻗는다 */
function floorLand(): Pose {
  const seat = seatPose("floor", false);
  return {
    ...seat,
    センター: { py: -SIT_DROP - 0.2 },
    上半身: { rx: 6 },
    ...legsOnFloor(SIT_DROP + 0.2, 120, false),
  };
}

/** 쪼그려 앉아 두 손을 무릎에 얹고 앉을 자리를 내려다본다 (앉기 전 잠깐 멈추는 자세) */
const CROUCH_LOOK: Pose = {
  ...CROUCH,
  センター: { py: -3.8 },
  上半身: { rx: -24 },
  首: { rx: 12 },
  左腕: { rz: -ARM_RELAX + 4, rx: 30 },
  右腕: { rz: ARM_RELAX - 4, rx: 30 },
  左ひじ: { ry: 40 },
  右ひじ: { ry: -40 },
  左足: { rx: 54, rz: -4 },
  右足: { rx: 54, rz: 4 },
  左ひざ: { rx: -106 },
  右ひざ: { rx: -106 },
  左足首: { rx: 52 },
  右足首: { rx: 52 },
};

/** 바닥: 쪼그린 채 한 손을 몸 뒤 바닥으로 뻗는다 (몸을 살짝 틀고 엉덩이를 내리기 시작) */
const FLOOR_REACH: Pose = {
  ...CROUCH_LOOK,
  センター: { py: -5.4 },
  上半身: { rx: -12, ry: -10 },
  首: { rx: 4, ry: -8 },
  左腕: { rz: -ARM_RELAX + 2, rx: 22 },
  右腕: { rz: ARM_RELAX + 10, rx: -34 },
  左ひじ: { ry: 26 },
  右ひじ: { ry: -6 },
  ...legsOnFloor(5.4, 72, true),
};

/** 바닥: 엉덩이를 대고 무릎을 세운 채 잠깐 (다리를 뻗기 전) */
function floorKneesUp(): Pose {
  const seat = seatPose("floor", false);
  return {
    ...seat,
    上半身: { rx: 7 },
    首: { rx: -4 },
    左腕: { rz: -ARM_RELAX - 6, rx: -26 },
    右腕: { rz: ARM_RELAX + 6, rx: -26 },
    ...legsOnFloor(SIT_DROP, 116, false),
  };
}

/** 걸터앉기: 쪼그린 채 두 손으로 창 테두리를 짚는다 (팔을 아래로 곧게, 상체를 숙여 무게를 손에) */
const EDGE_HANDS: Pose = {
  ...CROUCH_LOOK,
  センター: { py: -4.4 },
  上半身: { rx: -20 },
  首: { rx: 8 },
  左腕: { rz: -ARM_RELAX - 14, rx: 8 },
  右腕: { rz: ARM_RELAX + 14, rx: 8 },
  左ひじ: { ry: 8 },
  右ひじ: { ry: -8 },
  ...legsIk(4.4, 0),
};

/** 손으로 버티며 엉덩이를 뒤로 내린다 (발은 거의 제자리) */
const EDGE_SIT_BACK: Pose = {
  ...EDGE_HANDS,
  センター: { py: -7.4, pz: EDGE_BACK * 0.55 },
  上半身: { rx: -14 },
  首: { rx: 6 },
  左腕: { rz: -ARM_RELAX - 12, rx: -2 },
  右腕: { rz: ARM_RELAX + 12, rx: -2 },
  ...legsIk(7.4, EDGE_BACK * 0.55 + EDGE_FEET * 0.3),
};

/** 엉덩이가 테두리에 닿은 자세: 무릎을 세우고 발은 테두리 위, 두 손은 엉덩이 옆을 짚는다. lean: 상체 앞 숙임 */
function edgeKneesUp(lean: number): Pose {
  return {
    ...seatPose("edge", false),
    センター: { py: -SIT_DROP + 0.1, pz: EDGE_BACK },
    上半身: { rx: lean },
    首: { rx: 4 },
    左腕: { rz: -ARM_RELAX - 12, rx: -8 },
    右腕: { rz: ARM_RELAX + 12, rx: -8 },
    左ひじ: { ry: 10 },
    右ひじ: { ry: -10 },
    ...legsIk(SIT_DROP - 0.1, EDGE_BACK + EDGE_FEET),
  };
}

/** 무릎을 펴며 두 발을 테두리 앞 허공으로 내민다 (상체는 살짝 뒤로, 손은 그대로 짚고) */
function edgeLegsOut(): Pose {
  return {
    ...seatPose("edge", false),
    センター: { py: -SIT_DROP, pz: EDGE_BACK },
    上半身: { rx: 2 },
    首: { rx: 0, rz: 1 },
    左腕: { rz: -ARM_RELAX - 12, rx: -10 },
    右腕: { rz: ARM_RELAX + 12, rx: -10 },
    左ひじ: { ry: 10 },
    右ひじ: { ry: -10 },
    左足: { rx: 100, rz: -3 },
    右足: { rx: 97, rz: 3 },
    左ひざ: { rx: -34 },
    右ひざ: { rx: -44 },
    左足首: { rx: -20 },
    右足首: { rx: -16 },
  };
}

/** 종아리가 떨어져 늘어지는 순간: 살짝 더 내려앉고(다시 올라와 안착) 다리가 앞뒤로 엇갈린다 */
function edgeLand(): Pose {
  return {
    ...seatPose("edge", false),
    センター: { py: -SIT_DROP - 0.25, pz: EDGE_BACK },
    上半身: { rx: -4, ry: 0 },
    首: { rx: -1, rz: 1 },
    左ひざ: { rx: -96 },
    右ひざ: { rx: -84 },
  };
}

/** 걸터앉은 뒤 다리가 앞뒤로 한 번 더 흔들린다 (반동이 잦아든다) */
function edgeSwing(): Pose {
  return {
    ...seatPose("edge", false),
    上半身: { rx: -3, ry: 1 },
    首: { rx: -2, rz: 2 },
    左ひざ: { rx: -78 },
    右ひざ: { rx: -108 },
  };
}

/** 일어서기 전: 다리 흔들기를 멈추고 두 손으로 테두리를 짚는다 */
const EDGE_GRIP: Pose = {
  ...seatPose("edge", false),
  上半身: { rx: -6 },
  首: { rx: 3 },
  左腕: { rz: -ARM_RELAX - 12, rx: -6 },
  右腕: { rz: ARM_RELAX + 12, rx: -6 },
  左ひじ: { ry: 8 },
  右ひじ: { ry: -8 },
  左ひざ: { rx: -96 },
  右ひざ: { rx: -96 },
  左足首: { rx: -12 },
  右足首: { rx: -12 },
};

/**
 * 테두리 위에 세운 발로 올라서는 중간 자세. 상체를 숙이고 팔을 앞으로 내밀며 엉덩이를 들어 발 위로 옮긴다.
 * 발 자리를 정해 다리 각도를 구하므로(legsIk) 키 사이가 짧으면 발이 거의 미끄러지지 않는다.
 * drop: 센터 내림, back: 엉덩이를 뒤로 뺀 정도(EDGE_BACK 배수), feet: 발 자리(처음 선 자리에서 앞으로), arms: 팔 앞으로 든 각.
 */
function edgeRise(drop: number, back: number, lean: number, feet: number, arms: number): Pose {
  return {
    ...CROUCH,
    センター: { py: -drop, pz: EDGE_BACK * back },
    上半身: { rx: lean },
    首: { rx: 8 - lean * 0.15 },
    左腕: { rz: -ARM_RELAX + 6, rx: arms },
    右腕: { rz: ARM_RELAX - 6, rx: arms },
    左ひじ: { ry: ELBOW_RELAX + 14 },
    右ひじ: { ry: -ELBOW_RELAX - 14 },
    ...legsIk(drop, EDGE_BACK * back + feet),
  };
}

/** 바닥에서 일어설 때: 앉은 자리에서 상체를 숙이고 다리를 몸 쪽으로 당긴다 */
const FLOOR_GATHER: Pose = {
  ...CROUCH,
  センター: { py: -8.2 },
  上半身: { rx: -26 },
  首: { rx: 8 },
  左腕: { rz: -ARM_RELAX + 4, rx: 30 },
  右腕: { rz: ARM_RELAX - 4, rx: 30 },
  左足: { rx: 80, rz: -3 },
  右足: { rx: 80, rz: 3 },
  左ひざ: { rx: -118 },
  右ひざ: { rx: -118 },
  左足首: { rx: 40 },
  右足首: { rx: 40 },
};

/** 바닥에서 일어설 때 먼저: 뻗은 다리를 무릎을 세워 당기고 손은 뒤를 짚는다 */
const FLOOR_KNEES_IN: Pose = {
  ...seatPose("floor", false),
  上半身: { rx: 2 },
  左腕: { rz: -ARM_RELAX - 6, rx: -24 },
  右腕: { rz: ARM_RELAX + 6, rx: -24 },
  左足: { rx: 84, rz: -3 },
  右足: { rx: 84, rz: 3 },
  左ひざ: { rx: -112 },
  右ひざ: { rx: -112 },
  左足首: { rx: 34 },
  右足首: { rx: 34 },
};

/** 다 일어서기 직전: 상체가 살짝 뒤로 젖혀졌다가 바로 선다 (일어나는 힘이 남은 느낌) */
const STAND_SETTLE: Pose = {
  ...STAND,
  センター: { py: -0.25 },
  上半身: { rx: 3 },
  首: { rx: -3 },
  左足: { rx: 10 },
  右足: { rx: 10 },
  左ひざ: { rx: -21 },
  右ひざ: { rx: -21 },
  左足首: { rx: 11 },
  右足首: { rx: 11 },
};

/**
 * 몸 부위별 시간 차 (프레임, splinePose): 상체가 먼저 움직이고, 머리·팔·팔꿈치가 차례로 늦게 따라온다.
 * 모든 부위가 한꺼번에 움직이면 로봇처럼 보인다.
 */
const OVERLAP: Record<string, number> = {
  上半身: -2,
  首: 2,
  左腕: 3,
  右腕: 3,
  左ひじ: 4,
  右ひじ: 4,
};

/**
 * 앉기 전환. 한 단계씩 눈에 보이게 (예전 1.3초짜리는 서 있다가 툭 주저앉는 것처럼 보였다).
 * 바닥 (2.6초): 내려다봄 → 쪼그려 무릎에 손 → 한 손을 뒤 바닥으로 → 엉덩이를 내림 → 무릎 세우고 잠깐 → 다리를 뻗고 자리 잡기.
 * 걸터앉기 (3.1초): 내려다봄 → 쪼그림 → 두 손으로 테두리를 짚음 → 엉덩이를 뒤로 빼며 내려 무릎을 세우고 앉음(발은 테두리 위)
 *   → 무릎을 펴며 발을 테두리 앞으로 → 종아리가 떨어져 늘어지고 앞뒤로 흔들리다 자리 잡기.
 * 걸터앉았다 일어서기 (2.1초): 손으로 짚음 → 발을 앞으로 들어 테두리 위에 세움 → 상체를 숙이고 팔을 내밀며 발 위로 올라섬 → 일어섬.
 */
function sitDown(place: Seat): Motion {
  const edge = place === "edge";
  const length = edge ? 92 : 78;
  const steps = edge
    ? [
        { frame: 0, pose: STAND },
        { frame: 8, pose: PREPARE },
        { frame: 18, pose: CROUCH_LOOK },
        { frame: 28, pose: EDGE_HANDS },
        { frame: 38, pose: EDGE_SIT_BACK },
        { frame: 47, pose: edgeKneesUp(-10) },
        { frame: 53, pose: edgeKneesUp(-7) },
        { frame: 63, pose: edgeLegsOut() },
        { frame: 72, pose: edgeLand() },
        { frame: 81, pose: edgeSwing() },
        { frame: length, pose: seatPose(place, false) },
      ]
    : [
        { frame: 0, pose: STAND },
        { frame: 8, pose: PREPARE },
        { frame: 20, pose: CROUCH_LOOK },
        { frame: 28, pose: CROUCH_LOOK },
        { frame: 39, pose: FLOOR_REACH },
        { frame: 48, pose: FLOOR_LOWER },
        { frame: 55, pose: floorLand() },
        { frame: 64, pose: floorKneesUp() },
        { frame: length, pose: seatPose(place, false) },
      ];
  return defineMotion({
    name: `sit_down_${place}`,
    label: edge ? "걸터앉는 중" : "바닥에 앉는 중",
    loop: false,
    length,
    fadeIn: 0.12,
    legIk: false,
    bones: splinePose(steps, length, OVERLAP),
  });
}

function standUp(place: Seat): Motion {
  const edge = place === "edge";
  const length = edge ? 64 : 46;
  const steps = edge
    ? [
        { frame: 0, pose: seatPose(place, false) },
        { frame: 8, pose: EDGE_GRIP },
        { frame: 18, pose: edgeLegsOut() },
        { frame: 27, pose: edgeKneesUp(-14) },
        { frame: 32, pose: edgeRise(8.8, 0.8, -22, EDGE_FEET, 14) },
        { frame: 37, pose: edgeRise(7.4, 0.45, -30, EDGE_FEET, 34) },
        { frame: 42, pose: edgeRise(5.9, 0.15, -27, EDGE_FEET * 0.7, 34) },
        { frame: 47, pose: edgeRise(4.4, 0, -20, EDGE_FEET * 0.45, 28) },
        { frame: 56, pose: STAND_SETTLE },
        { frame: length, pose: STAND },
      ]
    : [
        { frame: 0, pose: seatPose(place, false) },
        { frame: 10, pose: FLOOR_KNEES_IN },
        { frame: 21, pose: FLOOR_GATHER },
        { frame: 30, pose: CROUCH },
        { frame: 39, pose: STAND_SETTLE },
        { frame: length, pose: STAND },
      ];
  return defineMotion({
    name: `stand_up_${place}`,
    label: edge ? "걸터앉았다 일어서기" : "바닥에서 일어서기",
    loop: false,
    length,
    fadeIn: 0.3,
    legIk: false,
    bones: splinePose(steps, length, OVERLAP),
  });
}

/** 매달리기(hang.ts) 0프레임 자세. 들고 있다 놓아 바로 걸터앉을 때 첫 프레임을 이것과 맞춰 자세가 튀지 않게 한다. */
const HANG: Pose = {
  センター: { py: 0 },
  上半身: { rx: -4, ry: -3 },
  首: { rx: -9, rz: 4 },
  左腕: { rz: -ARM_RELAX - 6, rx: ARM_FORWARD + 4 },
  右腕: { rz: ARM_RELAX + 3, rx: ARM_FORWARD + 9 },
  左ひじ: { ry: 10 },
  右ひじ: { ry: -16 },
  左足: { rx: 14, rz: -4 },
  右足: { rx: 5, rz: 3 },
  左ひざ: { rx: -30, rz: 9 },
  右ひざ: { rx: -14, rz: -6 },
  左足首: { rx: -22, ry: 8 },
  右足首: { rx: -18, ry: -8 },
};

/**
 * 들고 있다가 엉덩이가 창 테두리에 오게 놓으면 바로 걸터앉는다 (1.2초).
 * 첫 프레임은 매달린 자세 그대로. 행동이 발 기준점을 테두리로 옮기고 그림을 놓은 자리에서 8프레임에 걸쳐 테두리로 올리는
 * 동안(behavior.ts SEAT_DROP.glide) 엉덩이를 앉은 높이로 내려, 화면에서는 엉덩이가 제자리에서 테두리에 닿는다.
 * → 반동으로 다리가 앞으로 → 뒤로 흔들리다 → 자리 잡기.
 */
function sitDropEdge(): Motion {
  const length = 36;
  const seat = seatPose("edge", false);
  const hands = { 左腕: { rz: -ARM_RELAX - 12, rx: -6 }, 右腕: { rz: ARM_RELAX + 12, rx: -6 }, 左ひじ: { ry: 10 }, 右ひじ: { ry: -10 } };
  const steps = [
    { frame: 0, pose: HANG },
    {
      frame: 8,
      pose: {
        ...seat,
        ...hands,
        センター: { py: -SIT_DROP - 0.5, pz: EDGE_BACK * 0.4 },
        上半身: { rx: -10 },
        首: { rx: 6, rz: 2 },
        左足: { rx: 52, rz: -3 },
        右足: { rx: 44, rz: 3 },
        左ひざ: { rx: -52 },
        右ひざ: { rx: -40 },
        左足首: { rx: -18 },
        右足首: { rx: -16 },
      },
    },
    {
      frame: 15,
      pose: {
        ...seat,
        ...hands,
        センター: { py: -SIT_DROP + 0.15, pz: EDGE_BACK },
        上半身: { rx: -3 },
        首: { rx: -2, rz: 1 },
        左ひざ: { rx: -62 },
        右ひざ: { rx: -84 },
      },
    },
    { frame: 24, pose: { ...seat, 上半身: { rx: -4, ry: 1 }, 左ひざ: { rx: -106 }, 右ひざ: { rx: -78 } } },
    { frame: length, pose: seat },
  ];
  return defineMotion({
    name: "sit_drop_edge",
    label: "놓으면 걸터앉기",
    loop: false,
    length,
    fadeIn: 0,
    legIk: false,
    bones: splinePose(steps, length, OVERLAP),
    morphs: {
      trouble: [k(0, { w: 0.55 }), k(10, { w: 0 }), k(length, { w: 0 })],
      smile: [k(0, { w: 0 }), k(12, { w: 0.4 }), k(length, { w: 0.25 })],
    },
  });
}

/**
 * 앉은 채 머리를 쓰다듬을 때 (1.5초). 서 있을 때의 pat처럼 고개를 숙여 갸웃하고 어깨를 움츠리며 웃는다.
 * 걸터앉았으면 두 손을 무릎 위로 모으고 다리를 신나게 번갈아 흔들고, 바닥이면 뒤로 짚은 손은 그대로 둔다.
 * 처음·끝은 앉은 자세(반복 0프레임)라 앉기 반복과 이음매 없이 이어진다.
 */
function sitPat(place: Seat): Motion {
  const edge = place === "edge";
  const length = 45;
  const seat: Pose = { ...seatPose(place, false), 頭: {}, 左肩: {}, 右肩: {} };
  const lap: Pose = edge
    ? {
        左腕: { rz: -ARM_RELAX + 6, rx: ARM_FORWARD + 26, ry: 10 },
        右腕: { rz: ARM_RELAX - 6, rx: ARM_FORWARD + 26, ry: -10 },
        左ひじ: { ry: ELBOW_RELAX + 30 },
        右ひじ: { ry: -ELBOW_RELAX - 30 },
      }
    : {};
  const shrug = (tilt: number, kneeL: number, kneeR: number): Pose => ({
    ...seat,
    ...lap,
    上半身: { rx: edge ? -6 : 6 },
    首: { rx: -11, rz: tilt },
    頭: { rx: -5, rz: tilt * 0.6 },
    左肩: { rz: 5 },
    右肩: { rz: -5 },
    ...(edge ? ({ 左ひざ: { rx: kneeL }, 右ひざ: { rx: kneeR } } as Pose) : {}),
  });
  const steps = [
    { frame: 0, pose: seat },
    { frame: 8, pose: shrug(6, -82, -104) },
    { frame: 19, pose: shrug(-3, -106, -78) },
    { frame: 30, pose: shrug(4, -80, -102) },
    { frame: length, pose: seat },
  ];
  return defineMotion({
    name: `sit_pat_${place}`,
    label: edge ? "걸터앉아 쓰다듬기 반응" : "앉아서 쓰다듬기 반응",
    loop: false,
    length,
    fadeIn: 0.15,
    legIk: false,
    bones: splinePose(steps, length, OVERLAP),
    morphs: {
      smile: [k(0, { w: 0.25 }), k(6, { w: 1 }), k(38, { w: 1 }), k(length, { w: 0.25 })],
      shy: [k(0, { w: 0 }), k(10, { w: 0.6 }), k(40, { w: 0.6 }), k(length, { w: 0 })],
    },
  });
}

export const sitEdge = seatLoop("sit_edge", "걸터앉기", "edge", false);
export const sitFloor = seatLoop("sit_floor", "바닥에 앉기", "floor", false);
export const sleepEdge = seatLoop("sleep_edge", "걸터앉아 졸기", "edge", true);
export const sleepFloor = seatLoop("sleep_floor", "앉아서 졸기", "floor", true);
export const sitDownEdge = sitDown("edge");
export const sitDownFloor = sitDown("floor");
export const standUpEdge = standUp("edge");
export const standUpFloor = standUp("floor");
export const sitDropEdgeMotion = sitDropEdge();
export const sitPatEdge = sitPat("edge");
export const sitPatFloor = sitPat("floor");
