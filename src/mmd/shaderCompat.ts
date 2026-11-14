import { EscapeRegExp } from "babylon-mmd/esm/Loader/Shaders/escapeRegExp";
import { MmdPluginMaterial } from "babylon-mmd/esm/Loader/Shaders/mmdStandard";

/**
 * babylon-mmd 1.3은 표준 셰이더의 `baseColor=texture2D(diffuseSampler, …)` 줄을 찾아 텍스처 색
 * (재질 모프의 텍스처 계수, colorDepth)을 끼워 넣는데, Babylon 9는 이 줄을 `TEXRD(…)`로 써서
 * 치환이 걸리지 않고 텍스처 색이 조용히 무시된다. 같은 치환을 새 줄 모양에도 건다.
 */
const LEGACY_KEY = `!${EscapeRegExp("baseColor=texture2D(diffuseSampler,vDiffuseUV+uvOffset);")}`;
const CURRENT_KEY = `!${EscapeRegExp("baseColor=TEXRD(diffuseSampler,vDiffuseUV+uvOffset);")}`;

const getCustomCode = MmdPluginMaterial.prototype.getCustomCode;
MmdPluginMaterial.prototype.getCustomCode = function (shaderType) {
  const codes = getCustomCode.call(this, shaderType);
  if (codes && LEGACY_KEY in codes && !(CURRENT_KEY in codes)) codes[CURRENT_KEY] = codes[LEGACY_KEY];
  return codes;
};
