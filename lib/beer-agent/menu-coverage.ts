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
    ? extracted as { uncertainties?: unknown; items?: unknown }
    : {};
  const coverageWords = /反光|裁切|未纳入|看不清|不可读|空白|缺失|缺\s*\d|边缘|模糊|重叠|遮挡|不确定|可能是|易混|复核/;
  const uncertainties = Array.isArray(record.uncertainties)
    ? record.uncertainties
      .filter((value): value is string => typeof value === "string")
      .map(value => value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim())
      .filter(value => value.length > 0 && coverageWords.test(value))
      .slice(0, 4)
    : [];
  const items = Array.isArray(record.items)
    ? record.items
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    : [];
  const nonBeer = items
    .filter(item => /sparkling water|气泡水|苏打水|气泡饮/i.test(
      `${String(item.beerName ?? "")} ${String(item.style ?? "")} ${String(item.rawText ?? "")}`))
    .map(item => {
      const number = typeof item.menuIndex === "number" && item.menuIndex > 0 ? `#${item.menuIndex} ` : "";
      return `${number}${String(item.beerName ?? "未命名项").trim()}`;
    });
  const parts: string[] = [];
  if (candidateCount > 0 && uncertainties.length > 0) {
    const bounded = uncertainties
      .map(value => value.length > 90 ? `${value.slice(0, 89)}…` : value)
      .join("；");
    // The pipeline may pass all OCR rows (including non-beer) before the
    // recommendation layer filters them; report beer rows separately.
    const beerCount = candidateCount >= items.length && nonBeer.length > 0
      ? candidateCount - nonBeer.length
      : candidateCount;
    const total = items.length > 0 ? `OCR ${items.length} 项，` : "";
    parts.push(`图像边界（${total}啤酒 ${beerCount} 款；以下项不猜测）：${bounded}`);
  }
  if (nonBeer.length > 0) {
    parts.push(`非啤酒项：${nonBeer.join("、")}，未纳入逐款啤酒解读与推荐。`);
  }
  return parts.join("\n");
}
