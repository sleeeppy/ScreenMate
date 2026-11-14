import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";

/** Windows에서만 Pretendard를 쓴다 (`:root.windows`). 글꼴 파일은 실제로 쓰일 때만 받는다. */
if (navigator.userAgent.includes("Windows")) {
  document.documentElement.classList.add("windows");
}
