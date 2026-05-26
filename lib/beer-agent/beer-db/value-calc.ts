export type PriceInfo = {
  price: number;
  volumeMl: number | null;
  ratingScore: number | null;
};

export type ValueResult = {
  pricePerMl: number | null;
  pricePer100ml: number | null;
  valueScore: number | null;
};

/**
 * Calculate cost-effectiveness metrics.
 *
 * pricePerMl    — 元 per ml (absolute unit price)
 * pricePer100ml — 元 per 100ml (standardized for display)
 * valueScore    — rating per 1 yuan per 100ml (higher = better value)
 *
 * e.g. 88元/473ml, rating 4.2 → 18.6元/100ml → valueScore = 4.2 / 18.6 = 0.226
 * e.g.  8元/500ml, rating 3.2 →  1.6元/100ml → valueScore = 3.2 / 1.6  = 2.0
 */
export function calcValueScore(info: PriceInfo): ValueResult {
  const { price, volumeMl, ratingScore } = info;

  if (!volumeMl || volumeMl <= 0) {
    return { pricePerMl: null, pricePer100ml: null, valueScore: null };
  }

  const pricePerMl = price / volumeMl;
  const pricePer100ml = pricePerMl * 100;

  if (ratingScore === null || ratingScore === undefined) {
    return { pricePerMl, pricePer100ml, valueScore: null };
  }

  // How many rating points per 1 yuan per 100ml
  const valueScore = pricePer100ml > 0 ? ratingScore / pricePer100ml : null;

  return { pricePerMl, pricePer100ml, valueScore };
}

export function formatValueScore(valueScore: number | null): string {
  if (valueScore === null) return "暂无价格数据";
  if (valueScore >= 2.0) return "超值";
  if (valueScore >= 1.0) return "划算";
  if (valueScore >= 0.5) return "适中";
  if (valueScore >= 0.2) return "偏贵";
  return "很贵";
}

export function formatPriceInfo(price: number, volumeMl: number | null, valueScore: number | null): string {
  const parts: string[] = [];
  if (price) parts.push(`${price}元`);
  if (volumeMl) parts.push(`${volumeMl}ml`);
  if (parts.length === 0) return "暂无价格";

  const result = parts.join("/");
  if (valueScore !== null) {
    return `${result} · 性价比${formatValueScore(valueScore)}`;
  }
  return result;
}
