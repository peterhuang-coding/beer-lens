export type PriceInfo = {
  price: number;          // 元 (RMB)
  volumeMl: number | null;
  ratingScore: number | null;
  style?: string;
  abv?: number;
};

export type ValueResult = {
  pricePerMl: number | null;           // 元/ml
  pricePer100ml: number | null;        // 元/100ml
  valueScore: number | null;           // rating per ¥1 per 100ml (higher = better QPR)
  usBenchmark: number | null;          // estimated US taproom price in RMB (with tax)
  usPricePer100ml: number | null;      // US price per 100ml in RMB
  savingsVsUS: number | null;          // % cheaper than US (>0 = cheaper here)
  pricingBasis: string | null;         // human-readable label of which US benchmark was used
};

// US craft brewery taproom pricing estimates (USD, before tax)
// Based on 2024-2025 typical US craft brewery pricing
// Sources: personal observation at US craft breweries (2024-2025), BeerAdvocate/Untappd price tracking
const USD_PER_100ML: Record<string, { rate: number; label: string }> = {
  standard:  { rate: 1.48, label: "$7.00/品脱(473ml) — 拉格/皮尔森/淡色艾尔/小麦 美国酒厂标准价" },
  ipa:       { rate: 1.90, label: "$9.00/品脱(473ml) — IPA/Hazy IPA 美国酒厂标准价" },
  sour:      { rate: 2.10, label: "$8.00/10oz(296ml) — 酸啤/水果啤 美国酒厂标准价" },
  imperial:  { rate: 3.38, label: "$12.00/10-12oz — 帝国世涛/过桶/大麦酒 美国酒厂标准价" },
  specialty: { rate: 2.50, label: "$8-10/杯 — 比利时/赛松/特种啤酒 美国酒厂标准价" },
};

const USD_TO_CNY = 7.2;
const US_TAX_RATE = 0.08; // average US sales tax on draft beer

function getUsdPer100ml(style: string, abv?: number): { rate: number; label: string } {
  const s = style.toLowerCase();
  if (/imperial|double|triple|barrel.?aged|barley.?wine/i.test(s) || (abv && abv >= 10)) {
    return USD_PER_100ML.imperial;
  }
  if (/ipa|hazy|ddh|dry.?hopped/i.test(s) || (abv && abv >= 6.5)) {
    return USD_PER_100ML.ipa;
  }
  if (/sour|gose|berliner|lambic|wild|fruit/i.test(s)) {
    return USD_PER_100ML.sour;
  }
  if (/belgian|saison|farmhouse|trapist|dubbel|tripel|quad|stout|porter|brown|scotch/i.test(s) || (abv && abv >= 8)) {
    return USD_PER_100ML.specialty;
  }
  return USD_PER_100ML.standard;
}

export function calcValueScore(info: PriceInfo): ValueResult {
  const { price, volumeMl, ratingScore, style, abv } = info;

  if (!volumeMl || volumeMl <= 0) {
    return {
      pricePerMl: null, pricePer100ml: null, valueScore: null,
      usBenchmark: null, usPricePer100ml: null, savingsVsUS: null,
      pricingBasis: null,
    };
  }

  const pricePerMl = price / volumeMl;
  const pricePer100ml = pricePerMl * 100;

  // US benchmark: what this beer would cost in a US taproom (in RMB, with tax)
  const { rate: usdPer100ml, label: pricingBasis } = getUsdPer100ml(style ?? "", abv);
  const usPricePer100ml = usdPer100ml * USD_TO_CNY * (1 + US_TAX_RATE);
  const usBenchmark = usPricePer100ml * (volumeMl / 100);

  // Savings: how much cheaper (%) compared to US
  const savingsVsUS = usBenchmark > 0
    ? ((usBenchmark - price) / usBenchmark) * 100
    : null;

  // QPR: rating points per ¥1 per 100ml
  const valueScore = (ratingScore !== null && ratingScore !== undefined && pricePer100ml > 0)
    ? ratingScore / pricePer100ml
    : null;

  return {
    pricePerMl,
    pricePer100ml,
    valueScore,
    usBenchmark: Math.round(usBenchmark),
    usPricePer100ml,
    savingsVsUS: savingsVsUS !== null ? Math.round(savingsVsUS) : null,
    pricingBasis,
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

export function formatSavings(savingsVsUS: number | null): string {
  if (savingsVsUS === null) return "";
  if (savingsVsUS > 0) return `比美国便宜${savingsVsUS}%`;
  if (savingsVsUS < 0) return `比美国贵${Math.abs(savingsVsUS)}%`;
  return "跟美国持平";
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
