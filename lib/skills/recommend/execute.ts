/** Recommendation uses one constraint/decision path for images, text and follow-ups. */
import type { AgentContext, SkillResult } from "@/lib/agent/types";
import type { BeerCandidate } from "@/lib/beer-agent/types";
import { VisionError, suggest as suggestVisionError } from "../../multimodal/index.ts";
import { extractConstraints, mergeConstraints } from "../../beer-agent/recommendation/constraints.ts";
import { parseMenuInput, inferStyle, hasNamedMenuItems } from "../../beer-agent/recommendation/menu-input.ts";
import { recommendFromCandidates } from "../../beer-agent/recommendation/decision.ts";
import { readShortTermMemory } from "../../beer-agent/memory/short-term.ts";

function emptyPicks(): SkillResult["picks"] {
  const e = { candidateId: "", label: "", reason: "暂无", worthScore: 0, fitScore: 0 };
  return { topPick: e, safePick: e, explorePick: e, avoidOrCaution: e };
}

async function finish(ctx: AgentContext, candidates: BeerCandidate[], requestText: string, newMenu: boolean): Promise<SkillResult> {
  const { getProfileMemory } = await import("@/lib/beer-agent/memory/profile");
  const { isMemoryReadEnabled } = await import("@/lib/beer-agent/memory/memory-experiment");
  const memoryEnabled = await isMemoryReadEnabled(ctx.userId).catch(()=>false);
  const profile = memoryEnabled ? await getProfileMemory(ctx.userId).catch(()=>null) : null;
  const stm = newMenu ? null : await readShortTermMemory(ctx.conversationId,ctx.userId);
  const constraints = mergeConstraints(stm?.currentConstraints??[],extractConstraints(requestText));
  return {skillId:"recommend",...recommendFromCandidates(candidates,profile,constraints,memoryEnabled),profileSummary:profile?.summary??"",errors:[]};
}

async function handleImage(ctx: AgentContext): Promise<SkillResult> {
  try {
    const { runImagePipeline } = await import("@/lib/beer-agent/provider");
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY not configured");
    const pipeline = await runImagePipeline(apiKey,ctx.imageDataUrl!,ctx.lastUserText,ctx.profileSummary??"",ctx.onProgress);
    return finish(ctx,pipeline.candidates,ctx.lastUserText,true);
  } catch (err) {
    return {skillId:"recommend",reply:err instanceof VisionError?suggestVisionError(err):"抱歉，分析这张图片时出错了。请再试一次或直接告诉我酒名。",candidates:[],picks:emptyPicks(),profileSummary:"",errors:[err instanceof Error?err.message:String(err)]};
  }
}

async function handleFollowUp(ctx: AgentContext): Promise<SkillResult> {
  const stm = await readShortTermMemory(ctx.conversationId,ctx.userId);
  const candidates:BeerCandidate[] = (stm?.lastMenu?.candidates??[]).map((c,i)=>({
    ...c,candidateId:c.candidateId,menuIndex:c.menuIndex??i+1,hops:c.hops??[],evidence:c.evidence??[],riskFlags:c.riskFlags??[],
    worthScore:0,fitScore:0,reason:"",untappdScore:c.rating??null,untappdRatingCount:c.ratingsCount??null,
  }));
  if (!candidates.length) return {skillId:ctx.messages.some(m=>m.role==="assistant")?"follow-up-filter":"fallback",reply:"我还没有可核验的完整酒单上下文。请重新发一下酒单图片或具体酒名和价格，我再按你的要求筛选。",candidates:[],picks:emptyPicks(),profileSummary:ctx.profileSummary??"",errors:[]};
  return finish(ctx,candidates,ctx.lastUserText,false);
}

async function handleText(ctx: AgentContext): Promise<SkillResult> {
  const { lookupBeers, enrichCandidates } = await import("@/lib/beer-agent/beer-db/pipeline");
  const parsed = parseMenuInput(ctx.lastUserText);
  let items = parsed.items;
  if (parsed.isMenu && !items.length) return finish(ctx,[],parsed.requestText,true);
  if (!items.length) {
    const named = ctx.lastUserText.match(/[A-Za-z][A-Za-z0-9'’ -]{2,}/g)?.map(s=>s.trim()).filter(s=>! /^(?:IPA|NEIPA|ABV|stout|sour|lager|pilsner|hazy IPA|west coast IPA)$/i.test(s))??[];
    const queries = named.length ? named : genericRecommendationQueries(ctx.lastUserText);
    items = queries.map((beerName,i)=>({beerName,brewery:"",style:inferStyle(beerName),abv:0,price:null,volumeMl:null,menuIndex:i+1,rawText:beerName}));
  }
  const results = await lookupBeers(items.map(i=>i.beerName),items.map(i=>i.brewery));
  // Enrichment receives the same complete name and brewery as the local lookup.
  const misses = items.map((item,i)=>({item,i})).filter(({i})=>!results[i]?.found);
  const enriched = misses.length ? await enrichCandidates(misses.map(({item})=>({beerName:item.beerName,brewery:item.brewery,style:item.style,abv:item.abv}))).catch(()=>[]) : [];
  const byIndex = new Map(misses.map(({i},n)=>[i,enriched[n]]));
  const { assembleImageCandidates } = await import("@/lib/beer-agent/provider");
  // Text and OCR supply the same source facts and share identity/verification gates.
  const candidates = assembleImageCandidates(
    items.map(item=>({...item,serving:item.volumeMl!=null?`${item.volumeMl}ml`:"",confidence:1})),
    items.map((_,i)=>byIndex.get(i)??null), results,
  ).map(c=>({...c,candidateId:c.candidateId.replace('ocr_','text_'),evidence:c.evidence.map(e=>e.source==='ocr'?{...e,source:'manual_user_input' as const}:e)}));
  return finish(ctx,candidates,parsed.isMenu||hasNamedMenuItems(parsed.items)?parsed.requestText:ctx.lastUserText,true);
}

export async function execute(ctx:AgentContext,_params:Record<string,unknown>):Promise<SkillResult> {
  if(ctx.hasImage&&ctx.imageDataUrl) return handleImage(ctx);
  const parsed=parseMenuInput(ctx.lastUserText);
  if(parsed.isMenu) return handleText(ctx);
  const stm=await readShortTermMemory(ctx.conversationId,ctx.userId);
  const isFollowUp=isDeterministicShortQuestion(ctx.lastUserText)||extractConstraints(ctx.lastUserText).length>0||/第[一二三四五六七八九十0-9]+|哪(?:款|个)|换一款|再来一杯/.test(ctx.lastUserText);
  // A newly supplied proper name takes precedence over a style word inside it.
  const newName=hasNamedMenuItems(parsed.items);
  const referencesPrevious=/^(?:第[一二三四五六七八九十0-9]+|这个|这里面|这几款|这几杯|哪(?:个|款)|有没有|酒精度高不高)/.test(ctx.lastUserText) && !/推荐/.test(ctx.lastUserText);
  if((stm?.lastMenu?.candidates.length || referencesPrevious) && (isFollowUp || referencesPrevious) && !newName) return handleFollowUp(ctx);
  return handleText(ctx);
}

export function isDeterministicShortQuestion(text: string): boolean {
  const normalized = (text || "").trim();
  if (normalized.length === 0 || normalized.length > 12) return false;
  const patterns: RegExp[] = [
    /^(哪款|哪一款|哪一种|哪一杯|哪一个)\s*[?？。.\s]*$/i,
    /^这个\s*[?？。.\s]*$/i,
    /^(hello|hi|hey|你好|在吗)\s*[!！?？。.\s]*$/i,
  ];
  return patterns.some((p) => p.test(normalized));
}

function genericRecommendationQueries(text: string): string[] {
  const queries: string[] = [];
  if (/west\s*coast\s*ipa|西海岸/i.test(text)) queries.push("West Coast IPA");
  if (/hazy\s*ipa|浑浊\s*IPA/i.test(text)) queries.push("Hazy IPA");
  if (/IPA|ipa/i.test(text)) { queries.push("West Coast IPA"); queries.push("IPA"); }
  if (/拉格|lager|皮尔森|pils/i.test(text)) queries.push("Lager");
  if (/世涛|stout/i.test(text)) queries.push("Stout");
  if (/酸|sour|gose/i.test(text)) queries.push("Sour");
  if (/小麦|wheat|白啤|wit/i.test(text)) queries.push("Wheat Beer");
  if (/清爽|不苦|淡|light/i.test(text)) queries.push("Pilsner", "Session IPA");
  if (/烈|重口|帝国|double|imperial/i.test(text)) queries.push("Imperial Stout", "Double IPA");
  if (queries.length === 0) queries.push("IPA", "Stout", "Lager", "Sour");
  return [...new Set(queries)].slice(0, 4);
}
