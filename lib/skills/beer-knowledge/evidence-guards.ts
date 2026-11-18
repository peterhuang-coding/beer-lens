/**
 * Deterministic post-checks for knowledge replies.
 *
 * The text model can state a menu superlative ("lowest price"), add unsourced
 * brewery history, or call a beer over budget when it is not. A disclaimer
 * prefix is not enough: the contradicted sentence must not remain in the
 * visible answer. This module removes/rewrites those sentences and attaches
 * computed arithmetic/source/currency facts.
 */

type CandidateLike = {
  candidateId?: unknown;
  menuIndex?: unknown;
  displayName?: unknown;
  brewery?: unknown;
  price?: unknown;
  volumeMl?: unknown;
  currency?: unknown;
  evidence?: unknown;
  dossier?: {
    brewery?: { reputation?: unknown };
  } | null;
};

type MemoryLike = {
  lastMenu?: { candidates?: CandidateLike[] } | null;
  currentConstraints?: unknown;
} | null | undefined;

const SUPERLATIVE = /最低|最便宜|性价比最高|最划算|单价最低|价格最低/;
const OVER_BUDGET = /超预算|超出预算|略超预算|预算外/;
const HISTORY_CLAIM = /百年|老牌|创立|成立于|酒厂历史|历史悠久|传统酒厂|最畅销|旗舰|经典地位|获奖|经典/i;

function rowLabel(candidate: CandidateLike): string {
  const number = typeof candidate.menuIndex === "number" &&
    Number.isInteger(candidate.menuIndex) && candidate.menuIndex > 0
    ? `#${candidate.menuIndex} `
    : "";
  return `${number}${String(candidate.displayName ?? "").trim() || "未命名酒款"}`;
}

/** Explicit ISO code or a symbol actually visible in the OCR evidence. */
function explicitCurrency(candidate: CandidateLike): string | null {
  const currency = String(candidate.currency ?? "").trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(currency) && currency !== "UNKNOWN") return currency;
  const evidence = Array.isArray(candidate.evidence)
    ? candidate.evidence.map(entry => String((entry as { summary?: unknown })?.summary ?? "")).join(" ")
    : "";
  const raw = `${String(candidate.displayName ?? "")} ${String(candidate.brewery ?? "")} ${evidence}`;
  if (/¥|￥|CNY|RMB|人民币|元/.test(raw)) return "CNY";
  if (/\$|USD|美元/.test(raw)) return "USD";
  if (/€|EUR|欧元/.test(raw)) return "EUR";
  if (/£|GBP|英镑/.test(raw)) return "GBP";
  return null;
}

function moneyLabel(currency: string): string {
  return currency === "CNY" ? "元" : ` ${currency}`;
}

function priceText(pick: { candidate: CandidateLike; price: number; volumeMl: number; currency: string }): string {
  const money = moneyLabel(pick.currency);
  const unit = pick.price / pick.volumeMl * 100;
  return `${pick.price}${money} / ${pick.volumeMl}ml，${unit.toFixed(2)}${money}/100ml`;
}

function refsIn(text: string): number[] {
  return [...new Set([...text.matchAll(/#\s*(\d+)/g)].map(match => Number(match[1])))]
    .filter(value => Number.isInteger(value) && value > 0);
}

function mentionedCandidates(text: string, candidates: CandidateLike[]): CandidateLike[] {
  const refs = refsIn(text);
  const byRef = candidates.filter(candidate =>
    refs.includes(typeof candidate.menuIndex === "number" ? candidate.menuIndex : -1));
  const lower = text.toLowerCase();
  const byName = candidates.filter(candidate => {
    const brewery = String(candidate.brewery ?? "").trim().toLowerCase();
    const name = String(candidate.displayName ?? "").trim().toLowerCase();
    return (brewery.length >= 2 && lower.includes(brewery)) ||
      (name.length >= 2 && lower.includes(name));
  });
  return [...new Set([...byRef, ...byName])];
}

function reputationClaims(candidates: CandidateLike[]): Array<{ kind: string; text: string }> {
  return candidates.flatMap(candidate => {
    const reputation = candidate.dossier?.brewery?.reputation;
    if (!Array.isArray(reputation)) return [];
    return reputation
      .map(claim => {
        const value = (claim as { value?: unknown })?.value as { kind?: unknown; text?: unknown } | undefined;
        return {
          kind: String(value?.kind ?? ""),
          text: String(value?.text ?? ""),
        };
      })
      .filter(claim => claim.kind && claim.text);
  });
}

/** Bind a history/classic/flagship claim to the rows/breweries it names. */
function claimHasSource(text: string, candidates: CandidateLike[]): boolean {
  if (!HISTORY_CLAIM.test(text)) return true;
  const mentioned = mentionedCandidates(text, candidates);
  // A style-level phrase ("Czech Pilsner is a historic style") is not a claim
  // about a menu row and remains valid style knowledge.
  if (mentioned.length === 0) return true;
  const reputation = reputationClaims(mentioned);
  const checks: Array<(claim: { kind: string; text: string }) => boolean> = [];
  if (/旗舰|flagship/i.test(text)) checks.push(claim => claim.kind === "flagship");
  if (/最畅销|best.?sell/i.test(text)) checks.push(claim => /最畅销|best.?sell/i.test(claim.text));
  if (/获奖|award/i.test(text)) checks.push(claim => claim.kind === "award");
  if (/经典|classic/i.test(text)) checks.push(claim => claim.kind === "classic");
  if (/百年|老牌|创立|成立于|酒厂历史|历史悠久|传统酒厂/i.test(text)) {
    // A classic self-description does not prove a century of history.
    checks.push(claim => /百年|老牌|创立|成立于|since|founded|est\.|history|传统/i.test(claim.text));
  }
  return checks.every(check => reputation.some(check));
}

function maxPriceFrom(memory: MemoryLike): number | null {
  const constraints = Array.isArray(memory?.currentConstraints) ? memory!.currentConstraints! : [];
  const token = constraints.find((value): value is string =>
    typeof value === "string" && /^maxPrice:\d+(?:\.\d+)?$/.test(value));
  return token ? Number(token.slice("maxPrice:".length)) : null;
}

export function applyMenuEvidenceGuards(reply: string, memory: MemoryLike): string {
  const candidates = Array.isArray(memory?.lastMenu?.candidates)
    ? memory!.lastMenu!.candidates!
    : [];
  const priced = candidates.flatMap(candidate => {
    const price = typeof candidate.price === "number" && candidate.price > 0 ? candidate.price : null;
    const volumeMl = typeof candidate.volumeMl === "number" && candidate.volumeMl > 0 ? candidate.volumeMl : null;
    const currency = explicitCurrency(candidate);
    return price !== null && volumeMl !== null && currency !== null
      ? [{ candidate, price, volumeMl, currency }]
      : [];
  });
  const currencies = new Set(priced.map(pick => pick.currency));
  const hasUnknownCurrency = candidates.some(candidate =>
    typeof candidate.price === "number" && candidate.price > 0 &&
    typeof candidate.volumeMl === "number" && candidate.volumeMl > 0 &&
    explicitCurrency(candidate) === null);
  const notes: string[] = [];
  const maxPrice = maxPriceFrom(memory);

  let cheapestUnit: typeof priced[number] | null = null;
  let cheapestTotal: typeof priced[number] | null = null;
  if (currencies.size === 1 && priced.length > 0) {
    cheapestUnit = [...priced].sort((a, b) =>
      a.price / a.volumeMl - b.price / b.volumeMl ||
      Number(a.candidate.menuIndex ?? 0) - Number(b.candidate.menuIndex ?? 0))[0];
    cheapestTotal = [...priced].sort((a, b) =>
      a.price - b.price ||
      Number(a.candidate.menuIndex ?? 0) - Number(b.candidate.menuIndex ?? 0))[0];
  }

  const lines = reply.split(/\r?\n/);
  const kept: string[] = [];
  let droppedSuperlative = false;
  let droppedBudget = false;
  let droppedSource = false;

  for (const line of lines) {
    if (!line.trim()) { kept.push(line); continue; }

    if (SUPERLATIVE.test(line)) {
      const mentioned = mentionedCandidates(line, candidates);
      const mentionedIndices = mentioned
        .map(candidate => typeof candidate.menuIndex === "number" ? candidate.menuIndex : -1)
        .filter(index => index > 0);
      const unitClaim = /单位价|每\s*100|性价比/i.test(line);
      const totalClaim = /总价|杯价|单杯|价格最低|最便宜/.test(line);
      const required: number[] = [];
      if (currencies.size === 1) {
        if ((unitClaim || !totalClaim) && cheapestUnit) required.push(Number(cheapestUnit.candidate.menuIndex));
        if ((totalClaim || !unitClaim) && cheapestTotal) required.push(Number(cheapestTotal.candidate.menuIndex));
      }
      const aboutActualCheapest = required.length > 0 &&
        mentionedIndices.length > 0 &&
        mentionedIndices.every(index => required.includes(index)) &&
        required.every(index => mentionedIndices.includes(index));
      if (!aboutActualCheapest) {
        droppedSuperlative = true;
        continue; // never show a contradicted/unverifiable lowest claim
      }
    }

    if (OVER_BUDGET.test(line) && maxPrice !== null) {
      const mentioned = mentionedCandidates(line, candidates);
      const withinBudget = mentioned.some(candidate => {
        const price = typeof candidate.price === "number" && candidate.price > 0 ? candidate.price : null;
        const currency = explicitCurrency(candidate);
        return price !== null && price <= maxPrice && currency === "CNY";
      });
      if (withinBudget) {
        droppedBudget = true;
        continue;
      }
    }

    if (HISTORY_CLAIM.test(line) && !claimHasSource(line, candidates)) {
      droppedSource = true;
      continue;
    }

    kept.push(line);
  }

  if (droppedSuperlative) {
    if (currencies.size > 1) {
      notes.push(
        `【币种边界】当前菜单含 ${[...currencies].join("/")}；没有 FX、同版本、同消费形式来源，不能跨币种比较最低价。原回答中的最低价断言已移除。` +
        (hasUnknownCurrency ? "币种未知的款不参与比价。" : ""),
      );
    } else if (cheapestUnit && cheapestTotal) {
      notes.push(
        `【菜单算术核对】单位价最低的是 ${rowLabel(cheapestUnit.candidate)}（${priceText(cheapestUnit)}）；` +
        `单杯总价最低的是 ${rowLabel(cheapestTotal.candidate)}（${priceText(cheapestTotal)}）。` +
        `推荐理由是口味/风格匹配，不等于最低价或性价比最高；原回答中不一致的最低/最便宜断言已移除。`,
      );
    } else {
      notes.push("【菜单算术】当前没有可比的价格/容量/币种证据，不能声称最低或最便宜；原断言已移除。");
    }
  }

  if (droppedBudget && maxPrice !== null) {
    const within = candidates.filter(candidate => {
      const price = typeof candidate.price === "number" && candidate.price > 0 ? candidate.price : null;
      return price !== null && price <= maxPrice && explicitCurrency(candidate) === "CNY";
    });
    notes.push(
      `【预算核对】当前预算上限 ${maxPrice} 元；` +
      `${within.map(candidate => `${rowLabel(candidate)}（${candidate.price}元）`).join("、")} 均在预算内。` +
      `原回答中与预算不符的“超预算”断言已移除。`,
    );
  }

  if (droppedSource) {
    notes.push(
      "【来源核对】被说到的款/酒厂没有提供酒厂历史、经典、旗舰、最畅销或获奖的款级来源；" +
      "原回答中的这些说法已移除，只能算未核实常识。",
    );
  }

  const body = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return notes.length > 0
    ? `${notes.join("\n")}\n\n${body}`.trim()
    : reply;
}
