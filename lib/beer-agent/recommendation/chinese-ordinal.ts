const DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** Parse an explicit Chinese menu ordinal from 一 through 九十九. */
export function chineseOrdinal(text: string): number | null {
  text = text.replace(/\s+/g, '');
  if (!/^(?:[一二两三四五六七八九]|[一二两三四五六七八九]?十[一二两三四五六七八九]?)$/.test(text)) return null;
  let value = 0;
  let tens = false;

  for (const char of text) {
    if (char === '十') {
      if (tens) return null;
      value = value === 0 ? 10 : value * 10;
      tens = true;
      continue;
    }

    const digit = DIGITS[char];
    if (digit === undefined) return null;
    value = tens ? value + digit : digit;
  }

  return value > 0 && value <= 99 ? value : null;
}
