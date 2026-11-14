/**
 * Image coverage note for the first menu turn.
 *
 * The vision model reports unreadable/cropped rows in `extracted.uncertainties`.
 * The reply must surface those boundaries instead of silently presenting a
 * lower row count as a complete menu. This module is pure and treats every
 * model string as untrusted display data.
 */
export function formatImageCoverageNote(
  extracted: unknown,
  candidateCount: number,
): string {
  const record = extracted && typeof extracted === "object"
    ? extracted as { uncertainties?: unknown }
    : {};
  const coverageWords = /反光|裁切|未纳入|看不清|不可读|空白|缺失|缺\s*\d|边缘|模糊|重叠|遮挡|不确定|可能是|易混|复核/;
  const uncertainties = Array.isArray(record.uncertainties)
    ? record.uncertainties
      .filter((value): value is string => typeof value === "string")
      .map(value => value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim())
      .filter(value => value.length > 0 && coverageWords.test(value))
      .slice(0, 4)
    : [];
  if (candidateCount <= 0 || uncertainties.length === 0) return "";
  const bounded = uncertainties
    .map(value => value.length > 90 ? `${value.slice(0, 89)}…` : value)
    .join("；");
  return `图像边界（识别到 ${candidateCount} 款；以下项不猜测）：${bounded}`;
}
