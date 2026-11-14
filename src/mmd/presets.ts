import type { ProfileOverrides } from "./profile";

/**
 * 모델별 기본 보정 (저장소에 함께 있는 모델용). 모델 id는 가져온 폴더·파일 이름으로 정해진다.
 * 사용자 프로필의 overrides가 이 값보다 우선한다.
 *
 * - DIVA風水着: 재질 ambient가 커서 빛 받는 쪽이 하얗게 포화되고 음영이 거의 안 보인다 → ambient를 줄인다.
 *   검은 윤곽선도 굵어 보여서 조금 더 얇게.
 * - YYB: 윤곽선 색이 밝은 갈색·분홍이라 테두리가 도드라진다 → 더 얇게.
 * - YYB 미쿠 default: 소매·치마·부츠·머리에 더하기 스피어맵과 강한 스펙큘러가 있어 번들거린다 → 광택을 줄인다.
 * - Miwashiba式 린·렌: VRoid 기반이라 텍스처가 파스텔 톤이어서 색이 연하게 빠져 보인다 → 조금 진하게.
 */
const PRESETS: { match: RegExp; overrides: ProfileOverrides }[] = [
  { match: /^DIVA風水着セット--/, overrides: { ambientScale: 0.55, edgeScale: 0.75 } },
  { match: /^YYB式鏡音レン/, overrides: { edgeScale: 0.55 } },
  { match: /^YYB_Hatsune_Miku_default--/, overrides: { glossScale: 0.6 } },
  { match: /^Miwashiba式鏡音リンレン/, overrides: { colorDepth: 0.12 } },
];

export function presetOverrides(modelId: string): ProfileOverrides {
  return PRESETS.filter((preset) => preset.match.test(modelId)).reduce<ProfileOverrides>(
    (merged, preset) => ({ ...merged, ...preset.overrides }),
    {},
  );
}
