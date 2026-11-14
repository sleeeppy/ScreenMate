/**
 * 자율 행동용 모션: 뛰기(웅크리기 → 공중), 화면 가장자리에서 엿보기.
 * 몸 전체의 기울기·위치(옆 엿보기의 기울임, 아래에서 올라오기)는 행동(behavior.ts)이 정하고, 여기서는 자세만.
 */
import { defineMotion, k, type Key } from "../dsl.ts";
import { ARM_FORWARD, ARM_RELAX, ELBOW_RELAX } from "./pose.ts";

/** 좌우 대칭 팔 키: 左 값에서 右는 Z·Y 회전 부호를 뒤집는다 */
function mirrorArm(keys: readonly Key[]): Key[] {
  return keys.map((key) => ({ ...key, rz: key.rz === undefined ? undefined : -key.rz, ry: key.ry === undefined ? undefined : -key.ry }));
}

const relaxedLeft = { rz: -ARM_RELAX, rx: ARM_FORWARD };

/**
 * 뛰기 전 웅크리기 (0.4초). 0.3초에 행동이 몸을 띄운다 (JUMP_CROUCH).
 * 센터를 낮추면 발이 IK로 고정돼 무릎이 굽는다. 팔은 뒤로 젖혔다가 앞으로 휘두르며 뛴다.
 */
const jumpLeftArm = [
  k(0, relaxedLeft),
  k(7, { rz: -ARM_RELAX - 4, rx: -32, ease: "out" }),
  k(12, { rz: -ARM_RELAX + 14, rx: 34, ease: "in" }),
];
export const jump = defineMotion({
  name: "jump",
  label: "뛰기 (웅크리기)",
  loop: false,
  length: 12,
  fadeIn: 0.08,
  bones: {
    センター: [k(0), k(7, { py: -2.3, ease: "out" }), k(9, { py: -2.4 }), k(12, { py: -0.6, ease: "in" })],
    上半身: [k(0), k(7, { rx: -14 }), k(12, { rx: -5 })],
    首: [k(0, { rx: -1.5 }), k(7, { rx: 7 }), k(12, { rx: 0 })],
    左腕: jumpLeftArm,
    右腕: mirrorArm(jumpLeftArm),
    左ひじ: [k(0, { ry: ELBOW_RELAX }), k(7, { ry: 18 }), k(12, { ry: 28 })],
    右ひじ: [k(0, { ry: -ELBOW_RELAX }), k(7, { ry: -18 }), k(12, { ry: -28 })],
  },
  morphs: {
    joy: [k(0, { w: 0 }), k(10, { w: 0.6 }), k(12, { w: 0.6 })],
  },
});

/** 공중 (반복). 두 팔을 앞위로, 무릎을 당겨 웅크린다. 착지는 land가 받는다. */
const airLeftArm = [
  k(0, { rz: -ARM_RELAX + 16, rx: 52 }),
  k(10, { rz: -ARM_RELAX + 20, rx: 58 }),
  k(20, { rz: -ARM_RELAX + 16, rx: 52 }),
];
export const jumpAir = defineMotion({
  name: "jump_air",
  label: "뛰기 (공중)",
  loop: true,
  length: 20,
  fadeIn: 0.1,
  legIk: false,
  bones: {
    上半身: [k(0, { rx: -4 }), k(10, { rx: -2 }), k(20, { rx: -4 })],
    首: [k(0, { rx: 3 }), k(20, { rx: 3 })],
    左腕: airLeftArm,
    右腕: mirrorArm(airLeftArm),
    左ひじ: [k(0, { ry: 34 }), k(20, { ry: 34 })],
    右ひじ: [k(0, { ry: -34 }), k(20, { ry: -34 })],
    左足: [k(0, { rx: 40 }), k(10, { rx: 36 }), k(20, { rx: 40 })],
    右足: [k(0, { rx: 22 }), k(10, { rx: 26 }), k(20, { rx: 22 })],
    左ひざ: [k(0, { rx: -66 }), k(10, { rx: -60 }), k(20, { rx: -66 })],
    右ひざ: [k(0, { rx: -48 }), k(10, { rx: -54 }), k(20, { rx: -48 })],
    左足首: [k(0, { rx: -14 }), k(20, { rx: -14 })],
    右足首: [k(0, { rx: -14 }), k(20, { rx: -14 })],
  },
  morphs: {
    joy: [k(0, { w: 0.8 }), k(20, { w: 0.8 })],
    mouthA: [k(0, { w: 0.3 }), k(10, { w: 0.4 }), k(20, { w: 0.3 })],
  },
});

/**
 * 옆에서 크게 엿보기 (반복). 몸은 행동이 화면 쪽으로 기울인다. 여기서는 상체·목을 더 기울여 머리가 먼저 나오게 하고
 * 고개를 갸웃거리며 웃는다. side: 화면 왼쪽 끝이면 1 (머리를 화면 오른쪽으로), 오른쪽 끝이면 -1.
 * 上半身·首·頭 Z+ = 모델 왼쪽(정면에서 화면 오른쪽)으로 기울기.
 */
function peekSide(name: string, label: string, side: 1 | -1) {
  const tilt = (value: number) => value * side;
  return defineMotion({
    name,
    label,
    loop: true,
    length: 150,
    fadeIn: 0.4,
    bones: {
      上半身: [k(0, { rz: tilt(10) }), k(75, { rz: tilt(12) }), k(150, { rz: tilt(10) })],
      首: [k(0, { rz: tilt(12), rx: 2 }), k(40, { rz: tilt(18), rx: 3, ease: "inOut" }), k(90, { rz: tilt(8), rx: 1, ease: "inOut" }), k(150, { rz: tilt(12), rx: 2 })],
      頭: [k(0, { rz: tilt(6) }), k(40, { rz: tilt(10) }), k(90, { rz: tilt(3) }), k(150, { rz: tilt(6) })],
      左腕: [k(0, relaxedLeft), k(150, relaxedLeft)],
      右腕: [k(0, { rz: ARM_RELAX, rx: ARM_FORWARD }), k(150, { rz: ARM_RELAX, rx: ARM_FORWARD })],
    },
    morphs: {
      // smile은 모델에 따라 눈을 감는 웃음(笑い)이라 엿볼 때는 눈을 뜬 웃음(にこり)
      joy: [k(0, { w: 0.8 }), k(150, { w: 0.8 })],
      blink: [k(0, { w: 0 }), k(60, { w: 0 }), k(64, { w: 1 }), k(68, { w: 0 }), k(150, { w: 0 })],
    },
  });
}
export const peekLeft = peekSide("peek_left", "엿보기 (왼쪽 끝)", 1);
export const peekRight = peekSide("peek_right", "엿보기 (오른쪽 끝)", -1);

/**
 * 아래에서 크게 엿보기 (반복). 화면 아래 끝에 두 팔을 걸치고 턱을 괸 듯 앞으로 내밀고, 고개를 좌우로 갸웃.
 * 팔은 먼저 몸 옆으로 곧게 내린 뒤(Z) 앞으로 든다(X). 팔꿈치를 굽혀 아래팔이 몸 앞에서 모이게.
 */
const PEEK_DOWN = 90 - 37;
const peekUpLeftArm = [k(0, { rz: -PEEK_DOWN + 10, rx: 70 }), k(150, { rz: -PEEK_DOWN + 10, rx: 70 })];
export const peekUp = defineMotion({
  name: "peek_up",
  label: "엿보기 (아래에서)",
  loop: true,
  length: 150,
  fadeIn: 0.4,
  bones: {
    上半身: [k(0, { rx: -8 }), k(150, { rx: -8 })],
    首: [k(0, { rx: 6, rz: 6 }), k(45, { rx: 7, rz: -6, ease: "inOut" }), k(100, { rx: 6, rz: 8, ease: "inOut" }), k(150, { rx: 6, rz: 6 })],
    頭: [k(0, { rz: 4 }), k(45, { rz: -5 }), k(100, { rz: 6 }), k(150, { rz: 4 })],
    左腕: peekUpLeftArm,
    右腕: mirrorArm(peekUpLeftArm),
    左ひじ: [k(0, { ry: 95 }), k(150, { ry: 95 })],
    右ひじ: [k(0, { ry: -95 }), k(150, { ry: -95 })],
  },
  morphs: {
    joy: [k(0, { w: 0.8 }), k(150, { w: 0.8 })],
    blink: [k(0, { w: 0 }), k(80, { w: 0 }), k(84, { w: 1 }), k(88, { w: 0 }), k(150, { w: 0 })],
  },
});
