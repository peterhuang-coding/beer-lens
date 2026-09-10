type CandidateFacts = { displayName: string; style?: string; price?: number | null; abv?: number };

const STYLES: Record<string, RegExp> = {
  IPA: /\b(?:neipa|ipa)\b|浑浊|西海岸|印度淡色/i,
  lager: /lager|pils(?:ner)?|拉格|皮尔森|皮尔斯/i,
  stout: /stout|porter|世涛|波特/i,
  sour: /sour|gose|berliner|lambic|酸啤|酸的|古斯/i,
  wheat: /wheat|hefe|witbier|小麦|白啤/i,
};

/** Parse only the request, never the menu body. Tokens remain compatible with scoring. */
export function extractConstraints(text: string): string[] {
  const result: string[] = [];
  for (const [style, pattern] of Object.entries(STYLES)) {
    if (!pattern.test(text)) continue;
    const negated = /(?:不要|不喝|不想喝|排除|除了|不喜欢)\s*(?:任何)?\s*([^，,。；;]+)/g;
    let exclude = false;
    for (const match of text.matchAll(negated)) {
      // “不要太苦的 IPA” is still a request for IPA.
      if (!/^(?:太苦|苦|很苦)/.test(match[1]) && pattern.test(match[1].split(/(?:来个|来一|要一|改成|换成)/)[0])) exclude = true;
    }
    result.push(exclude ? `excludeStyle:${style}` : style);
  }
  if (/不(?:要太|喜欢|爱)?苦|不要苦|低苦|少苦|不想太苦/i.test(text)) result.push('不苦');
  if (/清爽|轻盈|crisp/i.test(text)) result.push('crisp');
  if (/尝新|探索|特别|explore/i.test(text)) result.push('explore');
  if (/第一杯|开场/i.test(text)) result.push('第一杯');

  const number = '(\\d+(?:\\.\\d+)?)';
  const pricePatterns = [
    new RegExp(`(?:预算|最多|不超过|不超|上限)(?:为|是|在)?\\s*[¥￥]?\\s*${number}\\s*(?:元|块)?`),
    new RegExp(`${number}\\s*(?:元|块)\\s*(?:以内|以下|内|封顶)`),
    new RegExp(`[¥￥]\\s*${number}\\s*(?:以内|以下)`),
  ];
  for (const p of pricePatterns) {
    const m = text.match(p);
    if (m && !/酒精|abv/i.test(text.slice(Math.max(0,m.index! - 8),m.index!))) { result.push(`maxPrice:${Number(m[1])}`); break; }
  }
  const range = text.match(/(?:ABV|酒精度)\s*(\d+(?:\.\d+)?)\s*[-~至到—]\s*(\d+(?:\.\d+)?)/i);
  if (range) result.push(`minAbv:${Number(range[1])}`, `maxAbv:${Number(range[2])}`);
  else {
    const max = text.match(/(?:ABV|酒精度)\s*(?:不超过|低于|最多|小于|低过)\s*(\d+(?:\.\d+)?)/i)
      ?? text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:以下|以内)/i);
    if (max) result.push(`maxAbv:${Number(max[1])}`);
    else if (/低度|酒精度低|低酒精/i.test(text)) result.push('maxAbv:4.5');
  }
  return [...new Set(result)];
}

/** Current values replace the same kind of earlier constraint, instead of accumulating forever. */
export function mergeConstraints(previous: string[], current: string[]): string[] {
  const family = (c: string) => STYLES[c] || c.startsWith('excludeStyle:') ? 'style' : /^(?:min|max)Abv:/.test(c) ? 'abv' : c.split(':')[0];
  const replaced = new Set(current.map(family));
  return [...new Set([...previous.filter(c => !replaced.has(family(c))), ...current])];
}

export function constraintFailures(candidate: CandidateFacts, constraints: string[]): string[] {
  const text = `${candidate.style ?? ''} ${candidate.displayName}`;
  const failures: string[] = [];
  const requestedStyles = constraints.filter(c => STYLES[c]);
  if (requestedStyles.length && !requestedStyles.some(s => STYLES[s].test(text))) failures.push(`不符合要求的风格：${requestedStyles.join('或')}`);
  for (const c of constraints) {
    if (c.startsWith('excludeStyle:') && STYLES[c.slice(13)]?.test(text)) failures.push('属于排除的风格');
    if (c.startsWith('maxPrice:')) {
      const max = Number(c.slice(9));
      if (candidate.price == null || candidate.price <= 0) failures.push('价格未知，无法确认是否符合预算');
      else if (candidate.price > max) failures.push(`超出预算 ¥${max}`);
    }
    if (c.startsWith('maxAbv:') || c.startsWith('minAbv:')) {
      const value = Number(c.split(':')[1]);
      if (!candidate.abv || candidate.abv <= 0) failures.push('酒精度未知，无法确认是否符合要求');
      else if (c.startsWith('maxAbv:') ? candidate.abv > value : candidate.abv < value) failures.push('酒精度不符合要求');
    }
  }
  return [...new Set(failures)];
}
