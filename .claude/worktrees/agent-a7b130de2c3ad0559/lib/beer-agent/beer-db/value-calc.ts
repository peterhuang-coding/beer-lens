export type PriceInfo = {
  price: number;          // 元 (RMB)
  volumeMl: number | null;
  ratingScore: number | null;
  style?: string;
  abv?: number;
  breweryCountry?: string | null;
};

export type ValueResult = {
  pricePerMl: number | null;           // 元/ml
  pricePer100ml: number | null;        // 元/100ml
  valueScore: number | null;           // rating per ¥1 per 100ml
  originBenchmark: number | null;      // estimated ORIGIN country price in RMB
  originPricePer100ml: number | null;  // origin country price per 100ml in RMB
  savingsVsOrigin: number | null;      // % cheaper than origin country (>0 = cheaper here)
  pricingBasis: string | null;         // human-readable label of which benchmark was used
};

// Country-specific craft beer taproom pricing (local currency per 100ml)
// Based on 2024-2025 typical pricing at local craft breweries
type CountryPricing = {
  currency: string;
  rate: number;          // local currency per 100ml for standard styles
  toCny: number;          // exchange rate to CNY
  label: string;
};

const COUNTRY_BENCHMARKS: Record<string, CountryPricing> = {
  US: { currency: "USD", rate: 1.48, toCny: 7.2, label: "美国酒厂 taproom 价" },
  GB: { currency: "GBP", rate: 1.10, toCny: 9.2, label: "英国酒厂 taproom 价" },
  DE: { currency: "EUR", rate: 0.80, toCny: 7.8, label: "德国酒厂 taproom 价" },
  BE: { currency: "EUR", rate: 0.85, toCny: 7.8, label: "比利时酒厂 taproom 价" },
  CZ: { currency: "CZK", rate: 10.0, toCny: 0.31, label: "捷克酒厂 taproom 价" },
  RU: { currency: "RUB", rate: 35.0, toCny: 0.08, label: "俄罗斯酒厂 taproom 价" },
  JP: { currency: "JPY", rate: 100.0, toCny: 0.048, label: "日本酒厂 taproom 价" },
  CN: { currency: "CNY", rate: 4.0, toCny: 1.0, label: "中国精酿酒厂 taproom 价" },
  AU: { currency: "AUD", rate: 2.0, toCny: 4.7, label: "澳大利亚酒厂 taproom 价" },
  NZ: { currency: "NZD", rate: 2.2, toCny: 4.3, label: "新西兰酒厂 taproom 价" },
  DK: { currency: "DKK", rate: 8.0, toCny: 1.05, label: "丹麦酒厂 taproom 价" },
  NL: { currency: "EUR", rate: 0.80, toCny: 7.8, label: "荷兰酒厂 taproom 价" },
};

// Style multipliers (same across countries, relative to standard lager/pils)
function styleMultiplier(style: string, abv?: number): number {
  const s = style.toLowerCase();
  if (/imperial|double|triple|barrel.?aged|barley.?wine/i.test(s) || (abv && abv >= 10)) return 2.3;
  if (/ipa|hazy|ddh|dry.?hopped/i.test(s) || (abv && abv >= 6.5)) return 1.3;
  if (/sour|gose|berliner|lambic|wild|fruit/i.test(s)) return 1.4;
  if (/belgian|saison|farmhouse|trapist|dubbel|tripel|quad|stout|porter|brown|scotch/i.test(s) || (abv && abv >= 8)) return 1.7;
  return 1.0;
}

function resolveCountry(country?: string | null): CountryPricing {
  if (!country) return COUNTRY_BENCHMARKS.US;

  // Map common country names/codes to keys
  const upper = country.toUpperCase().trim();
  const map: Record<string, string> = {
    "UNITED STATES": "US", "USA": "US", "AMERICA": "US",
    "UNITED KINGDOM": "GB", "UK": "GB", "ENGLAND": "GB", "SCOTLAND": "GB",
    "GERMANY": "DE", "DEUTSCHLAND": "DE",
    "BELGIUM": "BE", "BELGIË": "BE", "BELGIQUE": "BE",
    "CZECH REPUBLIC": "CZ", "CZECHIA": "CZ", "ČESKO": "CZ",
    "RUSSIA": "RU", "RUSSIAN FEDERATION": "RU", "РОССИЯ": "RU", "RUS": "RU",
    "JAPAN": "JP", "日本": "JP",
    "CHINA": "CN", "中国": "CN",
    "AUSTRALIA": "AU",
    "NEW ZEALAND": "NZ", "AOTEAROA": "NZ",
    "DENMARK": "DK", "DANMARK": "DK",
    "NETHERLANDS": "NL", "HOLLAND": "NL",
  };
  const key = map[upper] ?? (COUNTRY_BENCHMARKS[upper] ? upper : null);
  return key ? COUNTRY_BENCHMARKS[key] : COUNTRY_BENCHMARKS.US;
}

export function calcValueScore(info: PriceInfo): ValueResult {
  const { price, volumeMl, ratingScore, style, abv, breweryCountry } = info;

  if (!volumeMl || volumeMl <= 0) {
    return {
      pricePerMl: null, pricePer100ml: null, valueScore: null,
      originBenchmark: null, originPricePer100ml: null, savingsVsOrigin: null,
      pricingBasis: null,
    };
  }

  const pricePerMl = price / volumeMl;
  const pricePer100ml = pricePerMl * 100;

  // Origin country benchmark
  const country = resolveCountry(breweryCountry);
  const multiplier = styleMultiplier(style ?? "", abv);
  const originPricePer100mlLocal = country.rate * multiplier;
  const originPricePer100ml = originPricePer100mlLocal * country.toCny;
  const originBenchmark = originPricePer100ml * (volumeMl / 100);

  // Savings: how much cheaper (%) compared to origin country
  const savingsVsOrigin = originBenchmark > 0
    ? ((originBenchmark - price) / originBenchmark) * 100
    : null;

  // QPR: rating points per ¥1 per 100ml
  const valueScore = (ratingScore !== null && ratingScore !== undefined && pricePer100ml > 0)
    ? ratingScore / pricePer100ml
    : null;

  const countryLabel = breweryCountry
    ? `${country.label} (${country.currency} ${originPricePer100mlLocal.toFixed(1)}/100ml · ×${country.toCny})`
    : country.label;

  return {
    pricePerMl,
    pricePer100ml,
    valueScore,
    originBenchmark: Math.round(originBenchmark),
    originPricePer100ml,
    savingsVsOrigin: savingsVsOrigin !== null ? Math.round(savingsVsOrigin) : null,
    pricingBasis: countryLabel,
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
