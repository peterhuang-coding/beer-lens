export type PriceInfo = {
  price: number;          // 元 (RMB)
  volumeMl: number | null;
  ratingScore: number | null;
  style?: string;
  abv?: number;
  breweryCountry?: string | null;
};

export type ValueResult = {
  pricePerMl: number | null;
  pricePer100ml: number | null;
  valueScore: number | null;
  originBenchmark: number | null;
  originPricePer100ml: number | null;
  savingsVsOrigin: number | null;
  pricingBasis: string | null;
};

const NO_MARKET_COMPARISON = {
  originBenchmark: null,
  originPricePer100ml: null,
  savingsVsOrigin: null,
  pricingBasis: null,
} as const;

/**
 * Only menu arithmetic is computable here. Country/style constants and fixed FX
 * are not market offers. A future comparison needs an explicit same-product,
 * same-version, same-form offer with currency, tax basis and dated source/FX.
 */
export function calcValueScore(info: PriceInfo): ValueResult {
  const { price, volumeMl } = info;
  if (!Number.isFinite(price) || price < 0 || !volumeMl || volumeMl <= 0) {
    return {
      pricePerMl: null,
      pricePer100ml: null,
      valueScore: null,
      ...NO_MARKET_COMPARISON,
    };
  }

  const pricePerMl = price / volumeMl;
  return {
    pricePerMl,
    pricePer100ml: pricePerMl * 100,
    // Rating / price is not a universal value score: quality, unit cost and
    // personal fit remain separate. Keep the legacy field null for callers.
    valueScore: null,
    ...NO_MARKET_COMPARISON,
  };
}

export function formatValueScore(valueScore: number | null): string {
  if (valueScore === null) return "暂无数据";
  if (valueScore >= 2.0) return "超值";
  if (valueScore >= 1.0) return "划算";
  if (valueScore >= 0.5) return "适中";
  if (valueScore >= 0.2) return "偏贵";
  return "很贵";
}

export function formatSavings(savingsVsOrigin: number | null): string {
  if (savingsVsOrigin === null) return "";
  if (savingsVsOrigin > 0) return `比原产国便宜${savingsVsOrigin}%`;
  if (savingsVsOrigin < 0) return `比原产国贵${Math.abs(savingsVsOrigin)}%`;
  return "跟原产国持平";
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
