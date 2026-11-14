/**
 * 모델 보관함 정리 규칙 (설정 창). 화면·IPC와 떨어진 순수 함수라 Node에서 테스트한다.
 *
 * - 처음 열면 캐릭터별 폴더(카가미네 린, 카가미네 렌 …)를 만들어 넣는다. 모르는 캐릭터는 가져온 폴더에 모델이 둘 이상이면
 *   그 폴더 이름으로 묶고, 하나뿐이면 폴더 밖(맨 위)에 둔다.
 * - 새로 가져온 모델도 같은 규칙으로 넣되, 이미 같은 이름의 폴더가 있으면 거기에 넣는다.
 * - 사용자가 옮긴 자리(폴더 밖 포함)는 그대로 둔다.
 * - 폴더 안에 폴더를 만들 수 있다. 폴더를 지우면 안의 모델·폴더는 한 단계 위로 나온다.
 * - 폴더 이름은 같은 곳(같은 상위 폴더) 안에서만 겹치지 않게 한다.
 */
import type { Library, LibraryFolder } from "../ipc";

export interface ModelInfo {
  id: string;
  name: string;
  group: string;
  file: string;
}

/** 캐릭터 (폴더). 모델 이름으로 알아본다. */
export const CHARACTERS: { name: string; match: RegExp }[] = [
  { name: "카가미네 린", match: /鏡音リン|kagamine\s*rin/i },
  { name: "카가미네 렌", match: /鏡音レン|kagamine\s*len/i },
  { name: "하츠네 미쿠", match: /初音ミク|hatsune\s*miku/i },
  { name: "KAITO", match: /KAITO/i },
];

export const DEFAULT_FOLDER_NAME = "새 폴더";

export function emptyLibrary(): Library {
  return { organized: false, folders: [], placement: {}, titles: {} };
}

/** 알아본 캐릭터 이름. 모르면 null */
export function characterOf(model: ModelInfo): string | null {
  // 모델 이름 → 파일 이름 → 가져온 폴더 이름 순서로 본다.
  // 폴더 이름에는 여러 캐릭터가 같이 들어 있을 수 있다 (Sour式鏡音リン・レン → 렌 모델이 린 폴더로 가면 안 됨).
  const fileName = model.file.split("/").pop() ?? "";
  for (const text of [model.name, fileName, model.group]) {
    const found = CHARACTERS.find((character) => character.match.test(text));
    if (found) return found.name;
  }
  return null;
}

/** 짧은 이름: 캐릭터 이름·버전 번호를 뺀다 (Sour式鏡音レンVer.2.01 White → Sour式 White) */
export function shortName(model: ModelInfo): string {
  const short = model.name
    .replace(/鏡音(リン|レン)|初音ミク/g, " ")
    .replace(/\s*(Ver\.?|v)\s*\d+(\.\d+)*\s*/gi, " ")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return short || model.name;
}

/** 화면에 보일 이름: 바꾼 이름, 없으면 짧은 이름 */
export function titleOf(library: Library, model: ModelInfo): string {
  return library.titles[model.id]?.trim() || shortName(model);
}

export function newFolderId(): string {
  return `f${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function clone(library: Library): Library {
  return {
    organized: library.organized,
    folders: library.folders.map((folder) => ({ ...folder, parent: folder.parent ?? null })),
    placement: { ...library.placement },
    titles: { ...library.titles },
  };
}

/** 이 모델이 저절로 들어갈 폴더 이름 (없으면 폴더 밖) */
function homeOf(model: ModelInfo, models: readonly ModelInfo[]): string | null {
  const character = characterOf(model);
  if (character) return character;
  const siblings = models.filter((other) => other.group === model.group).length;
  return siblings >= 2 ? model.group : null;
}

/**
 * 처음 정리하거나 새로 들어온 모델(자리 정보가 없는 모델)을 넣는다.
 * 지워진 모델·폴더를 가리키는 값도 정리한다. 바뀐 게 없으면 changed=false.
 */
export function organize(
  library: Library,
  models: readonly ModelInfo[],
  makeId: () => string = newFolderId,
): { library: Library; changed: boolean } {
  const next = clone(library);
  let changed = false;
  const ids = new Set(models.map((model) => model.id));
  const folderIds = new Set(next.folders.map((folder) => folder.id));
  // 없는 상위 폴더를 가리키거나 서로 가리켜 맴도는 폴더는 맨 위로
  for (const folder of next.folders) {
    if (folder.parent !== null && (!folderIds.has(folder.parent) || ancestors(next, folder.id).includes(folder.id))) {
      folder.parent = null;
      changed = true;
    }
  }
  for (const id of Object.keys(next.placement)) {
    const target = next.placement[id];
    if (!ids.has(id)) {
      delete next.placement[id];
      changed = true;
    } else if (target !== null && !folderIds.has(target)) {
      next.placement[id] = null;
      changed = true;
    }
  }
  const fresh = next.organized ? models.filter((model) => !(model.id in next.placement)) : [...models];
  for (const model of fresh) {
    const home = homeOf(model, fresh);
    let folder = home ? next.folders.find((candidate) => candidate.name === home && candidate.parent === null) : undefined;
    if (home && !folder) {
      folder = { id: makeId(), name: home, parent: null };
      next.folders.push(folder);
    }
    next.placement[model.id] = folder?.id ?? null;
    changed = true;
  }
  if (!next.organized) {
    next.organized = true;
    changed = true;
  }
  return { library: next, changed };
}

export function folderOf(library: Library, id: string): string | null {
  return library.placement[id] ?? null;
}

export function folderById(library: Library, id: string | null): LibraryFolder | undefined {
  return id === null ? undefined : library.folders.find((folder) => folder.id === id);
}

/** 바로 아래 폴더 (null이면 맨 위 폴더) */
export function childFolders(library: Library, parent: string | null): LibraryFolder[] {
  return library.folders.filter((folder) => (folder.parent ?? null) === parent);
}

/** 위 폴더들 (가까운 것부터). 맴돌면 멈춘다 */
export function ancestors(library: Library, id: string): string[] {
  const out: string[] = [];
  let current = folderById(library, id)?.parent ?? null;
  while (current !== null && !out.includes(current)) {
    out.push(current);
    current = folderById(library, current)?.parent ?? null;
  }
  return out;
}

/** 맨 위부터 이 폴더까지 */
export function folderPath(library: Library, id: string | null): LibraryFolder[] {
  if (id === null) return [];
  return [...ancestors(library, id)]
    .reverse()
    .concat(id)
    .map((folderId) => folderById(library, folderId))
    .filter((folder): folder is LibraryFolder => !!folder);
}

/** 이 폴더 아래의 모든 폴더 (자신 빼고) */
export function descendants(library: Library, id: string): string[] {
  return library.folders.filter((folder) => ancestors(library, folder.id).includes(id)).map((folder) => folder.id);
}

/** 폴더 안(아래 폴더까지)의 모든 모델 */
export function modelsUnder<T extends ModelInfo>(library: Library, models: readonly T[], folderId: string): T[] {
  const inside = new Set([folderId, ...descendants(library, folderId)]);
  return models.filter((model) => {
    const target = folderOf(library, model.id);
    return target !== null && inside.has(target);
  });
}

/** 폴더를 다른 폴더 안으로 (null이면 맨 위). 자기 자신이나 자기 아래로는 못 옮긴다 */
export function moveFolder(library: Library, id: string, parent: string | null): Library {
  if (parent === id || (parent !== null && descendants(library, id).includes(parent))) return library;
  const next = clone(library);
  const folder = folderById(next, id);
  if (!folder || folder.parent === parent) return library;
  folder.parent = parent;
  folder.name = uniqueFolderName(next, folder.name, parent, id);
  return next;
}

/** 폴더 안(null이면 폴더 밖)의 모델. 가져온 순서 그대로 */
export function modelsIn<T extends ModelInfo>(library: Library, models: readonly T[], folderId: string | null): T[] {
  return models.filter((model) => folderOf(library, model.id) === folderId);
}

export function moveTo(library: Library, ids: readonly string[], folderId: string | null): Library {
  const next = clone(library);
  for (const id of ids) next.placement[id] = folderId;
  return next;
}

/** 같은 곳 안에서 겹치지 않는 폴더 이름: 새 폴더, 새 폴더 2, 새 폴더 3 … */
export function uniqueFolderName(
  library: Library,
  base = DEFAULT_FOLDER_NAME,
  parent: string | null = null,
  except?: string,
): string {
  const taken = new Set(
    childFolders(library, parent)
      .filter((folder) => folder.id !== except)
      .map((folder) => folder.name),
  );
  if (!taken.has(base)) return base;
  for (let index = 2; ; index++) {
    const name = `${base} ${index}`;
    if (!taken.has(name)) return name;
  }
}

export function createFolder(
  library: Library,
  name = DEFAULT_FOLDER_NAME,
  makeId: () => string = newFolderId,
  parent: string | null = null,
): { library: Library; folder: LibraryFolder } {
  const next = clone(library);
  const folder = { id: makeId(), name: uniqueFolderName(next, name.trim() || DEFAULT_FOLDER_NAME, parent), parent };
  next.folders.push(folder);
  return { library: next, folder };
}

/** 빈 이름이면 그대로. 다른 폴더와 이름이 같으면 뒤에 번호를 붙인다 */
export function renameFolder(library: Library, id: string, name: string): Library {
  const trimmed = name.trim();
  if (!trimmed) return library;
  const next = clone(library);
  const folder = next.folders.find((candidate) => candidate.id === id);
  if (folder) folder.name = uniqueFolderName(next, trimmed, folder.parent ?? null, id);
  return next;
}

/** 폴더만 지운다. 안의 모델·폴더는 한 단계 위로 (위 폴더도 지우면 그보다 위로) 나온다 */
export function deleteFolders(library: Library, ids: readonly string[]): Library {
  const next = clone(library);
  const survivingParent = (id: string | null): string | null => {
    let current = id;
    while (current !== null && ids.includes(current)) current = folderById(library, current)?.parent ?? null;
    return current;
  };
  for (const folder of next.folders) folder.parent = survivingParent(folder.parent);
  next.folders = next.folders.filter((folder) => !ids.includes(folder.id));
  for (const [model, target] of Object.entries(next.placement)) {
    if (target !== null && ids.includes(target)) next.placement[model] = survivingParent(target);
  }
  // 위로 나오면서 이름이 겹치면 번호를 붙인다
  for (const folder of next.folders) folder.name = uniqueFolderName(next, folder.name, folder.parent, folder.id);
  return next;
}

/** 이름을 비우거나 원래 이름과 같게 하면 바꾼 이름을 지운다 (원래대로) */
export function renameModel(library: Library, model: ModelInfo, title: string): Library {
  const next = clone(library);
  const trimmed = title.trim();
  if (!trimmed || trimmed === shortName(model)) delete next.titles[model.id];
  else next.titles[model.id] = trimmed;
  return next;
}

export function forgetModels(library: Library, ids: readonly string[]): Library {
  const next = clone(library);
  for (const id of ids) {
    delete next.placement[id];
    delete next.titles[id];
  }
  return next;
}
