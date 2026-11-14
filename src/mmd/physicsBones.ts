/**
 * 물리 뼈 떨림 거르기(physicsSmoothing.ts)에서 어떤 뼈를 어느 뼈 기준으로 거를지 정한다.
 * Babylon을 쓰지 않는 순수 함수라 Node에서 테스트한다.
 */

/** PMX 강체 물리 방식: 0 뼈를 따름, 1 물리, 2 물리 + 뼈 위치 */
const FOLLOW_BONE = 0;

/**
 * 거를 뼈 → 기준(매달린) 뼈. 물리가 움직이는 뼈(물리 방식 1·2)와 그 아래 뼈가 대상이고,
 * 기준은 대상이 아닌 가장 가까운 조상이다. 조상이 없으면(맨 위) 대상에서 뺀다.
 */
export function physicsBoneAnchors(
  bones: readonly { parentBoneIndex: number }[],
  rigidBodies: readonly { boneIndex: number; physicsMode: number }[],
): Map<number, number> {
  const driven = new Set<number>();
  for (const body of rigidBodies) {
    if (body.physicsMode !== FOLLOW_BONE && body.boneIndex >= 0 && body.boneIndex < bones.length) driven.add(body.boneIndex);
  }
  const inSet = new Map<number, boolean>();
  const smoothed = (index: number, depth = 0): boolean => {
    if (index < 0 || index >= bones.length || depth > bones.length) return false;
    const known = inSet.get(index);
    if (known !== undefined) return known;
    const result = driven.has(index) || smoothed(bones[index].parentBoneIndex, depth + 1);
    inSet.set(index, result);
    return result;
  };
  const anchors = new Map<number, number>();
  for (let index = 0; index < bones.length; index++) {
    if (!smoothed(index)) continue;
    let anchor = bones[index].parentBoneIndex;
    let guard = 0;
    while (anchor >= 0 && smoothed(anchor) && guard++ < bones.length) anchor = bones[anchor].parentBoneIndex;
    if (anchor >= 0 && anchor < bones.length) anchors.set(index, anchor);
  }
  return anchors;
}

/** 팔·손 강체로 보는 뼈 이름 (어깨는 빼고 위팔부터) */
const ARM_BONE = /腕|ひじ|肘|手首|手捩|^.?手$|袖/;
/** 치마처럼 아래 몸에 매달린 강체의 기준 뼈 */
const LOWER_BODY = "下半身";
/** 이름으로 알아보는 치마·옷자락 (Sour 린처럼 치마 뼈를 上半身에 붙인 모델도 있다) */
const SKIRT = /スカート|ｽｶｰﾄ|skirt|裾|すそ/i;

/**
 * 치마가 팔에 걸리지 않게 할 충돌 마스크: 강체 번호 → 새 마스크.
 *
 * 걸을 때 팔을 앞뒤로 흔들면 팔 강체(뼈를 따르는 캡슐)가 치마 강체를 쳐서 치마가 최대 100px 넘게 튀어 올랐다 (Sour 린).
 * 치마·옷자락 물리 강체(이름에 スカート·skirt·裾가 있거나 下半身 아래에 매달린 것)는 "팔·손 강체만 있는 충돌 그룹"과
 * 부딪히지 않게 한다.
 * 몸통과 팔이 섞인 그룹은 몸통 충돌이 없어지므로 건드리지 않는다. 머리카락 등 다른 강체는 그대로 팔과 부딪힌다.
 */
export function skirtArmMasks(
  bones: readonly { name: string; parentBoneIndex: number }[],
  rigidBodies: readonly { name: string; boneIndex: number; physicsMode: number; collisionGroup: number; collisionMask: number }[],
): Map<number, number> {
  const isArm = (body: { name: string; boneIndex: number }) =>
    ARM_BONE.test(body.name) || ARM_BONE.test(bones[body.boneIndex]?.name ?? "");
  // 그룹마다: 뼈를 따르는 강체가 모두 팔·손이면 팔 그룹
  const groupHasArm = new Map<number, boolean>();
  const groupHasOther = new Set<number>();
  for (const body of rigidBodies) {
    if (isArm(body) && body.physicsMode === FOLLOW_BONE) groupHasArm.set(body.collisionGroup, true);
    else groupHasOther.add(body.collisionGroup);
  }
  let armBits = 0;
  for (const [group] of groupHasArm) if (!groupHasOther.has(group) && group >= 0 && group < 16) armBits |= 1 << group;
  if (armBits === 0) return new Map();

  const lowerBody = bones.findIndex((bone) => bone.name === LOWER_BODY);
  const underLowerBody = (index: number) => {
    if (lowerBody < 0) return false;
    let current = index;
    for (let guard = 0; current >= 0 && guard <= bones.length; guard++) {
      if (current === lowerBody) return true;
      current = bones[current].parentBoneIndex;
    }
    return false;
  };
  const masks = new Map<number, number>();
  rigidBodies.forEach((body, index) => {
    if (body.physicsMode === FOLLOW_BONE || body.boneIndex === lowerBody) return;
    const skirt = SKIRT.test(body.name) || SKIRT.test(bones[body.boneIndex]?.name ?? "") || underLowerBody(body.boneIndex);
    if (!skirt) return;
    if ((body.collisionMask & armBits) === 0) return;
    masks.set(index, body.collisionMask & ~armBits);
  });
  return masks;
}
