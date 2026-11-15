/**
 * Deterministic post-checks for knowledge replies.
 *
 * The text model can state a menu superlative ("lowest price") or add
 * unsourced brewery history even when the prompt forbids it. These checks do
 * not rewrite the model's prose; they prepend a short, computed correction so
 * the user never sees an unchecked claim as the final word.
 */

type CandidateLike = {
  candidateId?: unknown;
  menuIndex?: unknown;
  displayName?: unknown;
  brewery?: unknown;
  price?: unknown;
  volumeMl?: unknown;
  dossier?: {
    brewery?: { reputation?: unknown };
  } | null;
};

type MemoryLike = {
  lastMenu?: { candidates?: CandidateLike[] } | null;
  currentConstraints?: unknown;
} | null | undefined;

function rowLabel(candidate: CandidateLike): string {
  const number = typeof candidate.menuIndex === "number" &&
    Number.isInteger(candidate.menuIndex) && candidate.menuIndex > 0
    ? `#${candidate.menuIndex} `
    : "";
  return `${number}${String(candidate.displayName ?? "").trim() || "未命名酒款"}`;
}

function priceText(candidate: { price: number; volumeMl: number }): string {
  return `${candidate.price}元/${candidate.volumeMl}ml，${(candidate.price / candidate.volumeMl * 100).toFixed(2)}元/100ml`;
}

export function applyMenuEvidenceGuards(reply: string, memory: MemoryLike): string {
  const candidates = Array.isArray(memory?.lastMenu?.candidates)
    ? memory!.lastMenu!.candidates!
    : [];
  const priced = candidates.flatMap(candidate => {
    const price = typeof candidate.price === "number" && candidate.price > 0 ? candidate.price : null;
    const volumeMl = typeof candidate.volumeMl === "number" && candidate.volumeMl > 0 ? candidate.volumeMl : null;
    return price !== null && volumeMl !== null ? [{ candidate, price, volumeMl }] : [];
  });
  const notes: string[] = [];

  if (priced.length > 0 && /最低|最便宜|性价比最高|最划算|单价最低|价格最低/.test(reply)) {
    const cheapestUnit = [...priced].sort((a, b) =>
      a.price / a.volumeMl - b.price / b.volumeMl ||
      Number(a.candidate.menuIndex ?? 0) - Number(b.candidate.menuIndex ?? 0))[0];
    const cheapestTotal = [...priced].sort((a, b) =>
      a.price - b.price ||
      Number(a.candidate.menuIndex ?? 0) - Number(b.candidate.menuIndex ?? 0))[0];
    notes.push(
      `【菜单算术核对】单位价最低的是 ${rowLabel(cheapestUnit.candidate)}（${priceText(cheapestUnit)}）；` +
      `单杯总价最低的是 ${rowLabel(cheapestTotal.candidate)}（${priceText(cheapestTotal)}）。` +
      `推荐理由是口味/风格匹配，不等于最低价或性价比最高。`,
    );
  }

  const maxPriceToken = Array.isArray(memory?.currentConstraints)
    ? memory!.currentConstraints!.find((value): value is string =>
      typeof value === "string" && /^maxPrice:\d+(?:\.\d+)?$/.test(value))
    : undefined;
  const maxPrice = maxPriceToken ? Number(maxPriceToken.slice("maxPrice:".length)) : null;
  if (maxPrice !== null && Number.isFinite(maxPrice) && /超预算|超出预算|略超预算|预算外/.test(reply)) {
    const refs = [...reply.matchAll(/#\s*(\d+)/g)].map(match => Number(match[1]));
    const mentioned = [...new Set(refs)]
      .map(number => candidates.find(candidate => Number(candidate.menuIndex) === number))
      .filter((candidate): candidate is CandidateLike => Boolean(candidate));
    const within = mentioned.filter(candidate =>
      typeof candidate.price === "number" && candidate.price > 0 && candidate.price <= maxPrice);
    const over = mentioned.filter(candidate =>
      typeof candidate.price === "number" && candidate.price > maxPrice);
    if (within.length > 0) {
      notes.push(
        `【预算核对】当前预算上限 ${maxPrice} 元；` +
        `${within.map(candidate => `${rowLabel(candidate)}（${candidate.price}元）`).join("、")} 均在预算内，不能表述为“超预算”。` +
        (over.length > 0
          ? `超预算的是 ${over.map(candidate => `${rowLabel(candidate)}（${candidate.price}元）`).join("、")}。`
          : ""),
      );
    }
  }

  const hasBreweryHistory = /百年|老牌|创立|成立于|酒厂历史|历史悠久|传统酒厂|最畅销|旗舰|经典地位|获奖/.test(reply);
  const hasSourcedReputation = candidates.some(candidate => {
    const reputation = candidate.dossier?.brewery?.reputation;
    return Array.isArray(reputation) && reputation.length > 0;
  });
  if (hasBreweryHistory && !hasSourcedReputation) {
    notes.push(
      "【来源核对】当前菜单证据没有提供酒厂历史、百年老牌、经典地位、旗舰或获奖的款级来源 Claim；" +
      "这些背景只能算未核实常识，不能作为已核实事实。",
    );
  }

  return notes.length > 0 ? `${notes.join("\n")}\n\n${reply}` : reply;
}
