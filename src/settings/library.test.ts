import assert from "node:assert/strict";
import { test } from "node:test";
import {
  childFolders,
  createFolder,
  deleteFolders,
  folderPath,
  moveFolder,
  modelsUnder,
  emptyLibrary,
  modelsIn,
  moveTo,
  organize,
  renameFolder,
  renameModel,
  titleOf,
  type ModelInfo,
} from "./library.ts";

const model = (id: string, name: string, group: string, file = `${group}/${id}.pmx`): ModelInfo => ({ id, name, group, file });

const MODELS: ModelInfo[] = [
  model("diva-rin", "DIVA風水着", "DIVA風水着セット", "DIVA/鏡音リン_DIVA風水着.pmd"),
  model("diva-len", "DIVA風水着", "DIVA風水着セット", "DIVA/鏡音レン_DIVA風水着.pmd"),
  model("sour-rin", "Sour式鏡音リンVer.2.01 Black", "Sour式鏡音リン・レンVer.2.01"),
  model("sour-len", "Sour式鏡音レンVer.2.01 White", "Sour式鏡音リン・レンVer.2.01"),
  model("solo", "Original Chara", "OriginalPack"),
  model("pair-a", "Robo A", "RoboPack"),
  model("pair-b", "Robo B", "RoboPack"),
];

let counter = 0;
const ids = () => `f${++counter}`;

test("처음 정리: 캐릭터별 폴더, 모르는 캐릭터는 가져온 폴더에 둘 이상일 때만 묶는다", () => {
  const { library } = organize(emptyLibrary(), MODELS, ids);
  const names = library.folders.map((folder) => folder.name);
  assert.deepEqual(names, ["카가미네 린", "카가미네 렌", "RoboPack"]);
  const rin = library.folders[0].id;
  assert.deepEqual(modelsIn(library, MODELS, rin).map((m) => m.id), ["diva-rin", "sour-rin"]);
  assert.deepEqual(modelsIn(library, MODELS, null).map((m) => m.id), ["solo"]);
  assert.equal(library.organized, true);
});

test("새로 가져온 모델은 같은 이름의 폴더로, 사용자가 옮긴 자리는 그대로", () => {
  const first = organize(emptyLibrary(), MODELS, ids).library;
  const moved = moveTo(first, ["diva-rin"], null);
  const added = [...MODELS, model("yyb-len", "YYB式鏡音レンv1.00", "YYB式鏡音レンver1.00")];
  const { library, changed } = organize(moved, added, ids);
  assert.equal(changed, true);
  const len = library.folders.find((folder) => folder.name === "카가미네 렌")!.id;
  assert.equal(library.placement["yyb-len"], len);
  assert.equal(library.placement["diva-rin"], null, "밖으로 꺼낸 모델은 다시 넣지 않는다");
  assert.equal(organize(library, added, ids).changed, false);
});

test("폴더를 지우면 안의 모델은 밖으로 나오고, 지운 모델은 정리에서 빠진다", () => {
  const first = organize(emptyLibrary(), MODELS, ids).library;
  const rin = first.folders.find((folder) => folder.name === "카가미네 린")!.id;
  const removed = deleteFolders(first, [rin]);
  assert.equal(removed.folders.some((folder) => folder.id === rin), false);
  assert.equal(removed.placement["sour-rin"], null);
  const { library } = organize(removed, MODELS.filter((m) => m.id !== "solo"), ids);
  assert.equal("solo" in library.placement, false);
});

test("새 폴더 이름은 겹치지 않고, 이름을 바꿀 때도 겹치면 번호를 붙인다", () => {
  let library = emptyLibrary();
  library = createFolder(library, undefined, ids).library;
  const second = createFolder(library, undefined, ids);
  library = second.library;
  assert.deepEqual(library.folders.map((folder) => folder.name), ["새 폴더", "새 폴더 2"]);
  library = renameFolder(library, second.folder.id, "새 폴더");
  assert.equal(library.folders[1].name, "새 폴더 2");
  library = renameFolder(library, second.folder.id, "  즐겨찾기 ");
  assert.equal(library.folders[1].name, "즐겨찾기");
  assert.equal(renameFolder(library, second.folder.id, "   "), library, "빈 이름은 무시");
});

test("모델 이름 바꾸기: 비우거나 원래 이름으로 하면 원래대로", () => {
  const sour = MODELS[3];
  let library = renameModel(emptyLibrary(), sour, "  하얀 렌 ");
  assert.equal(titleOf(library, sour), "하얀 렌");
  library = renameModel(library, sour, "");
  assert.equal(titleOf(library, sour), "Sour式 White");
  library = renameModel(renameModel(library, sour, "x"), sour, "Sour式 White");
  assert.equal(sour.id in library.titles, false);
});

test("폴더 안 폴더: 경로, 같은 곳 안에서만 이름 겹침 확인, 자기 아래로는 못 옮김", () => {
  let library = organize(emptyLibrary(), MODELS, ids).library;
  const rin = library.folders.find((folder) => folder.name === "카가미네 린")!;
  const fav = createFolder(library, "즐겨찾기", ids, rin.id);
  library = fav.library;
  const deep = createFolder(library, "즐겨찾기", ids, fav.folder.id);
  library = deep.library;
  assert.equal(deep.folder.name, "즐겨찾기", "다른 곳이면 같은 이름 가능");
  assert.equal(createFolder(library, "즐겨찾기", ids, rin.id).folder.name, "즐겨찾기 2");
  assert.deepEqual(folderPath(library, deep.folder.id).map((folder) => folder.name), ["카가미네 린", "즐겨찾기", "즐겨찾기"]);
  assert.equal(moveFolder(library, rin.id, deep.folder.id), library, "자기 아래로는 안 됨");
  assert.equal(moveFolder(library, rin.id, rin.id), library);
  library = moveTo(library, ["sour-rin"], deep.folder.id);
  assert.deepEqual(modelsUnder(library, MODELS, rin.id).map((m) => m.id), ["diva-rin", "sour-rin"]);
  const moved = moveFolder(library, deep.folder.id, null);
  assert.equal(childFolders(moved, null).some((folder) => folder.id === deep.folder.id), true);
});

test("폴더를 지우면 안의 모델·폴더는 한 단계 위로", () => {
  let library = organize(emptyLibrary(), MODELS, ids).library;
  const rin = library.folders.find((folder) => folder.name === "카가미네 린")!;
  const fav = createFolder(library, "즐겨찾기", ids, rin.id);
  library = fav.library;
  const inner = createFolder(library, "안쪽", ids, fav.folder.id);
  library = moveTo(inner.library, ["sour-rin"], fav.folder.id);
  const removed = deleteFolders(library, [fav.folder.id]);
  assert.equal(removed.placement["sour-rin"], rin.id);
  assert.equal(removed.folders.find((folder) => folder.id === inner.folder.id)!.parent, rin.id);
  const both = deleteFolders(library, [rin.id, fav.folder.id]);
  assert.equal(both.placement["sour-rin"], null);
  assert.equal(both.folders.find((folder) => folder.id === inner.folder.id)!.parent, null);
});
