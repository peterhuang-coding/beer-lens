type CandidateFacts = { displayName: string; style?: string; price?: number | null; volumeMl?: number | null; abv?: number; ibu?: number | null };

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
  if (/单位价|每\s*100\s*(?:ml|毫升)|每毫升/i.test(text)) result.push('priceGoal:unit');
  else if (/性价比|划算|值不值/i.test(text)) result.push('priceGoal:compare');
  else if (/最便宜|少花|省钱|总价最低|杯价最低/i.test(text)) result.push('priceGoal:total');

  const number = '(\\d+(?:\\.\\d+)?)';
  const priceRange = text.match(new RegExp(`预算(?:为|是|在)?\\s*[¥￥]?\\s*${number}\\s*(?:-|~|至|到|—)\\s*[¥￥]?\\s*${number}(?:\\s*(?:元|块))?`, 'i'))
    ?? text.match(new RegExp(`[¥￥]?\\s*${number}\\s*(?:-|~|至|到|—)\\s*[¥￥]?\\s*${number}\\s*(?:元|块)`, 'i'));
  if (priceRange) {
    const low = Number(priceRange[1]);
    const high = Number(priceRange[2]);
    result.push(`minPrice:${Math.min(low, high)}`, `maxPrice:${Math.max(low, high)}`);
  }
  const pricePatterns = [
    new RegExp(`(?:预算|最多|不超过|不超|上限|放宽到|调整到|提高到|改到)(?:为|是|在)?\\s*[¥￥]?\\s*${number}\\s*(?:元|块)?`),
    new RegExp(`${number}\\s*(?:元|块)\\s*(?:以内|以下|内|封顶)`),
    new RegExp(`[¥￥]\\s*${number}\\s*(?:以内|以下)`),
  ];
  if (!priceRange) {
    for (const p of pricePatterns) {
      const m = text.match(p);
      if (m && !/酒精|abv/i.test(text.slice(Math.max(0,m.index! - 8),m.index!))) { result.push(`maxPrice:${Number(m[1])}`); break; }
    }
  }
  const range = text.match(/(?:ABV|酒精度)\s*(\d+(?:\.\d+)?)\s*[-~至到—]\s*(\d+(?:\.\d+)?)/i);
  if (range) result.push(`minAbv:${Number(range[1])}`, `maxAbv:${Number(range[2])}`);
  else {
    const max = text.match(/(?:ABV|酒精度)\s*(?:不超过|低于|最多|小于|低过)\s*(\d+(?:\.\d+)?)/i)
      ?? text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:以下|以内)/i);
    if (max) result.push(`maxAbv:${Number(max[1])}`);
    else if (/低度|酒精度低|低酒精/i.test(text)) result.push('maxAbv:4.5');
  }
  const ibuRange = text.match(/IBU\s*(\d+(?:\.\d+)?)\s*[-~至到—]\s*(\d+(?:\.\d+)?)/i);
  if (ibuRange) result.push(`minIbu:${Math.min(Number(ibuRange[1]), Number(ibuRange[2]))}`, `maxIbu:${Math.max(Number(ibuRange[1]), Number(ibuRange[2]))}`);
  else {
    const maxIbu = text.match(/IBU\s*(?:不超过|低于|最多|小于|≤|<=)\s*(\d+(?:\.\d+)?)/i)
      ?? text.match(/(?:苦度|IBU)\s*(\d+(?:\.\d+)?)\s*(?:以下|以内)/i);
    if (maxIbu) result.push(`maxIbu:${Number(maxIbu[1])}`);
  }
  return [...new Set(result)];
}

/** Current values replace the same kind of earlier constraint, instead of accumulating forever. */
export function mergeConstraints(previous: string[], current: string[]): string[] {
  const family = (c: string) => STYLES[c] || c.startsWith('excludeStyle:') ? 'style' : /^(?:min|max)Abv:/.test(c) ? 'abv' : /^(?:min|max)Ibu:/.test(c) ? 'ibu' : /^(?:min|max)Price:/.test(c) ? 'price' : c.startsWith('priceGoal:') ? 'priceGoal' : c.split(':')[0];
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
    if (c.startsWith('minPrice:')) {
      const min = Number(c.slice(9));
      if (candidate.price == null || candidate.price <= 0) failures.push('价格未知，无法确认是否符合预算');
      else if (candidate.price < min) failures.push(`低于预算下限 ¥${min}`);
    }
    if (c === 'priceGoal:unit' || c === 'priceGoal:compare') {
      if (candidate.price == null || candidate.price <= 0) failures.push('价格未知，无法比较单位价');
      if (candidate.volumeMl == null || candidate.volumeMl <= 0) failures.push('容量未知，无法比较单位价');
    }
    if (c === 'priceGoal:total' && (candidate.price == null || candidate.price <= 0)) failures.push('价格未知，无法比较总价');
    if (c.startsWith('maxAbv:') || c.startsWith('minAbv:')) {
      const value = Number(c.split(':')[1]);
      if (!candidate.abv || candidate.abv <= 0) failures.push('酒精度未知，无法确认是否符合要求');
      else if (c.startsWith('maxAbv:') ? candidate.abv > value : candidate.abv < value) failures.push('酒精度不符合要求');
    }
    if (c.startsWith('maxIbu:') || c.startsWith('minIbu:')) {
      const value = Number(c.split(':')[1]);
      if (candidate.ibu == null || candidate.ibu < 0) failures.push('IBU 未知，无法确认是否符合苦度要求');
      else if (c.startsWith('maxIbu:') ? candidate.ibu > value : candidate.ibu < value) failures.push('IBU 不符合要求');
    }
  }
  return [...new Set(failures)];
}
