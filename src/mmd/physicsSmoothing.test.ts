import assert from "node:assert/strict";
import { test } from "node:test";
import { physicsBoneAnchors, skirtArmMasks } from "./physicsBones.ts";

test("물리 뼈와 그 아래 뼈를 물리가 아닌 가장 가까운 조상 기준으로 거른다", () => {
  // 0 センター → 1 下半身 → 2 スカート_0 → 3 スカート_1 → 4 スカート先(물리 없음)
  //            └ 5 上半身 → 6 頭 → 7 髪_0(물리 + 뼈 위치)
  const bones = [-1, 0, 1, 2, 3, 0, 5, 6].map((parentBoneIndex) => ({ parentBoneIndex }));
  const rigidBodies = [
    { boneIndex: 1, physicsMode: 0 }, // 下半身: 뼈를 따름
    { boneIndex: 2, physicsMode: 1 },
    { boneIndex: 3, physicsMode: 1 },
    { boneIndex: 7, physicsMode: 2 },
    { boneIndex: 6, physicsMode: 0 },
  ];
  const anchors = physicsBoneAnchors(bones, rigidBodies);
  assert.deepEqual(
    [...anchors].sort((a, b) => a[0] - b[0]),
    [
      [2, 1],
      [3, 1],
      [4, 1],
      [7, 6],
    ],
  );
});

test("물리 뼈가 맨 위(조상 없음)이거나 강체 뼈 번호가 이상하면 빼고, 물리가 없으면 비어 있다", () => {
  const bones = [-1, 0].map((parentBoneIndex) => ({ parentBoneIndex }));
  assert.equal(physicsBoneAnchors(bones, [{ boneIndex: 0, physicsMode: 1 }]).size, 0);
  assert.equal(physicsBoneAnchors(bones, [{ boneIndex: 9, physicsMode: 1 }]).size, 0);
  assert.equal(physicsBoneAnchors(bones, []).size, 0);
});

test("下半身 아래 물리 강체(치마)는 팔·손만 있는 충돌 그룹과 부딪히지 않게 한다", () => {
  // 0 センター → 1 下半身 → 2 スカート ; 0 → 3 上半身 → 4 右腕 → 5 右ひじ ; 3 → 6 頭 → 7 髪
  const bones = [
    { name: "センター", parentBoneIndex: -1 },
    { name: "下半身", parentBoneIndex: 0 },
    { name: "スカート_0_0", parentBoneIndex: 1 },
    { name: "上半身", parentBoneIndex: 0 },
    { name: "右腕", parentBoneIndex: 3 },
    { name: "右ひじ", parentBoneIndex: 4 },
    { name: "頭", parentBoneIndex: 3 },
    { name: "髪", parentBoneIndex: 6 },
  ];
  const body = (name: string, boneIndex: number, physicsMode: number, collisionGroup: number, collisionMask = 0xffff) => ({
    name,
    boneIndex,
    physicsMode,
    collisionGroup,
    collisionMask,
  });
  const rigidBodies = [
    body("下半身", 1, 0, 0),
    body("右腕", 4, 0, 1),
    body("右ひじ", 5, 0, 1),
    body("スカート_0_0", 2, 1, 3, 0xfff7),
    body("髪", 7, 1, 2, 0xffff),
  ];
  const masks = skirtArmMasks(bones, rigidBodies);
  assert.deepEqual([...masks], [[3, 0xfff7 & ~0b10]]);
  // 치마 뼈를 上半身에 붙인 모델(Sour 린)도 이름으로 알아본다
  const onUpperBody = bones.map((bone) => (bone.name.startsWith("スカート") ? { ...bone, parentBoneIndex: 3 } : bone));
  assert.deepEqual([...skirtArmMasks(onUpperBody, rigidBodies)], [[3, 0xfff7 & ~0b10]]);
  // 팔 그룹에 몸통이 섞여 있으면 건드리지 않는다
  const mixed = rigidBodies.map((rb) => (rb.name === "下半身" ? { ...rb, collisionGroup: 1 } : rb));
  assert.equal(skirtArmMasks(bones, mixed).size, 0);
});
