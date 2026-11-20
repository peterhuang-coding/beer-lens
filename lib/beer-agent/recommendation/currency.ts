/**
 * Currency labels inferred only from the menu's own visible symbol.
 *
 * OCR often returns `currency: "unknown"` even when the row clearly shows ¥.
 * Treating that as a foreign currency would reject every yuan budget, while
 * treating a genuinely symbol-less row as CNY would invent a currency. The
 * evidence string is the tie-breaker; an explicit non-CNY code always wins.
 */
export type CurrencyFacts = {
  currency?: string;
  evidence?: Array<{ summary?: string }>;
};

export function moneyLabel(c: CurrencyFacts): string {
  const currency = String(c.currency ?? '').trim();
  if (currency && currency.toLowerCase() !== 'unknown') {
    return currency === 'CNY' ? '元' : ` ${currency}`;
  }
  const evidence = Array.isArray(c.evidence)
    ? c.evidence.map(entry => String(entry?.summary ?? '')).join(' ')
    : '';
  if (/¥|￥|CNY|RMB|人民币|元/i.test(evidence)) return '元';
  if (/\$|USD|美元/i.test(evidence)) return ' USD';
  if (/€|EUR|欧元/i.test(evidence)) return ' EUR';
  if (/£|GBP|英镑/i.test(evidence)) return ' GBP';
  return '（币种未知）';
}

/** Return a comparable code; unknown stays "unknown" unless visible evidence
 *  identifies a currency. Legacy rows with no currency field remain CNY. */
export function normalizedCurrency(c: CurrencyFacts): string {
  const currency = String(c.currency ?? '').trim();
  if (currency && currency.toLowerCase() !== 'unknown') return currency;
  const label = moneyLabel(c);
  if (label === '元') return 'CNY';
  if (label === ' USD') return 'USD';
  if (label === ' EUR') return 'EUR';
  if (label === ' GBP') return 'GBP';
  return currency || 'CNY';
}
