import type { ScoredCandidate, PickResult } from './types.ts';
import { selectPicks } from './pick-selector.ts';
import { chineseOrdinal } from './chinese-ordinal.ts';

const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
export const unitPrice = (c: ScoredCandidate) => positive(c.price) && positive(c.volumeMl) ? c.price / c.volumeMl * 100 : null;
export function offerText(c: ScoredCandidate): string {
  const unit = unitPrice(c);
  const money = c.currency && c.currency!=='CNY' ? ` ${c.currency}` : '元';
  return `${positive(c.price) ? `${c.price}${money}` : '价格未知'} / ${positive(c.volumeMl) ? `${c.volumeMl}ml` : '容量未知'}${unit == null ? '' : `，${unit.toFixed(2)}${money}/100ml`}`;
}

/** Only explicit menu references select rows; budgets, ABV and serving digits never do. */
export function purchaseScope<T extends ScoredCandidate>(rows: T[], request: string): { rows: T[]; error?: string; explicit: boolean } {
  const numbers = [...request.matchAll(/第\s*([一二两三四五六七八九十]{1,3})\s*(?:号|款|个|杯)|第\s*(\d+)\s*(?:号|款|个|杯)|#\s*(\d+)|(\d+)\s*号/g)]
    .map(m => m[1] !== undefined ? chineseOrdinal(m[1]) : Number(m[2] ?? m[3] ?? m[4]))
    .filter((n): n is number => n !== null);
  if (numbers.length) {
    const chosen: T[] = [];
    for (const n of new Set(numbers)) {
      const matches = rows.filter(c=>c.menuIndex===n);
      if(matches.length!==1) return {rows:[],explicit:true,error:`无法唯一确认酒单第${n}号，请补充具体酒名或清晰编号后再比较。`};
      chosen.push(matches[0]);
    }
    return {rows:chosen,explicit:true};
  }
  if (/只(?:比较|考虑|选)|(?:和|与|跟).*(?:比较|哪|选)/.test(request)) {
    const named=rows.filter(c=>c.displayName.length>1&&request.toLowerCase().includes(c.displayName.toLowerCase()));
    if(named.length>=2) return {rows:named,explicit:true};
    if (/只(?:比较|考虑|选)/.test(request)) return {rows:[],explicit:true,error:'无法确认你指定的全部比较对象，请提供酒单编号或完整酒名。'};
  }
  return {rows,explicit:false};
}

export function purchaseDecision(rows: ScoredCandidate[], request: string, explicit: boolean): {reply:string;picks:PickResult}|null {
  const value=/性价比|划算|值得买|值不值|单位价|每\s*100\s*ml|价差|差价|比价|最便宜/i.test(request);
  if(!value&&!explicit) return null;
  if(!rows.length) return null;
  const facts=rows.map(c=>`第${c.menuIndex||'?'}号 ${c.displayName}：${offerText(c)}${positive(c.abv)?`；ABV ${c.abv}%`:''}。`);
  if(rows.some(c=>unitPrice(c)==null))return {picks:selectPicks([]),reply:[...facts,'价格或容量信息缺失，无法可靠比较性价比。请补充实际报价、容量、币种和堂饮/外带规格；评分不能代替价格证据。'].join('\n')};
  const currencies = new Set(rows.map(c=>c.currency??'CNY'));
  const modes = new Set(rows.map(c=>c.servingMode??'legacy'));
  if(currencies.size!==1 || !currencies.has('CNY') || modes.size!==1 || modes.has('unknown')) return {picks:selectPicks([]),reply:'当前只支持同币种人民币、同消费形式的价量比较。币种或消费形式未知/不一致，请补充确认，不作跨币种或堂饮与外带的性价比排名。'};
  const volume=request.match(/(?:只想喝|想喝|要喝|容量(?:为|是)?|想要)\s*(\d+(?:\.\d+)?)\s*ml/i);
  const desired=volume?Number(volume[1]):null;
  const byUnit=/单位价.*(?:低|比较)|哪.*单位价|每\s*100\s*ml.*(?:低|便宜)|按单位价/i.test(request);
  const byTotal=/最便宜|最低(?:杯价|价格)|杯价.*最低/.test(request);
  const ordered=[...rows].sort((a,b)=>{
    if(desired&&positive(a.volumeMl)&&positive(b.volumeMl)){
      const diff=Math.abs(a.volumeMl-desired)-Math.abs(b.volumeMl-desired);if(diff)return diff;
    }
    if(byUnit)return unitPrice(a)!-unitPrice(b)!;
    if(byTotal)return a.price!-b.price!;
    return (b.fitScore+b.worthScore)-(a.fitScore+a.worthScore);
  });
  const top=ordered[0],alt=ordered[1];
  const empty=selectPicks([]);
  const pick=(c:ScoredCandidate,label:string)=>({candidateId:c.candidateId,label,reason:offerText(c),worthScore:c.worthScore,fitScore:c.fitScore});
  const picks={...empty,topPick:pick(top,'首选'),safePick:alt?pick(alt,'备选'):empty.safePick};
  const lines=[...facts,`首选 ${top.displayName}：${desired?`更接近本次${desired}ml的容量需求`:byUnit?'在可比较候选中单位价较低':byTotal?'在可比较候选中杯价较低':'先按已知口味与预算匹配选择'}。`];
  if(alt){const delta=alt.price!-top.price!;lines.push(`备选 ${alt.displayName}：${delta===0?'杯价相同':`比首选${delta>0?'贵':'便宜'}${Number(Math.abs(delta).toFixed(2))}元`}，容量${alt.volumeMl}ml。`);}
  lines.push('以上只比较当前酒单图示价格，单位价低不代表品质更好；币种、消费形式需一致，不能据此声称市场最低价。实际苦度与新鲜度仍需确认。');
  if(desired)lines.push('大杯单位价低不代表更符合这次想喝的量；还需考虑酒精度。');
  return {picks,reply:lines.join('\n')};
}
