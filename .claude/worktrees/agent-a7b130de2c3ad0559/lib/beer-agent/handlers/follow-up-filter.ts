import type { BeerDialogRequest } from "@/lib/beer-agent/dialog-types";
import type { HandlerContext } from "@/lib/beer-agent/handler-types";
import type { AgentResponse, BeerCandidate, Pick } from "@/lib/beer-agent/types";
import { emptyPicks } from "@/lib/beer-agent/handler-types";
import { readShortTermMemory } from "@/lib/beer-agent/memory/short-term";
import { getProfileMemory } from "@/lib/beer-agent/memory/profile";
import { scoreCandidates } from "@/lib/beer-agent/recommendation/scoring";
import { selectPicks } from "@/lib/beer-agent/recommendation/pick-selector";
import { buildRecommendationReply } from "@/lib/beer-agent/recommendation/reply-builder";
import type { ScoredCandidate } from "@/lib/beer-agent/recommendation/types";

export async function handleFollowUpFilter(
  request: BeerDialogRequest,
  context: HandlerContext
): Promise<AgentResponse> {
  const stm = await readShortTermMemory(request.conversationId).catch(() => null);
  const menuCandidates = stm?.lastMenu?.candidates ?? [];

  if (menuCandidates.length === 0) {
    return {
      mode: "recommend",
      reply: "我现在没有上一张酒单上下文，你发一下酒单或告诉我酒名，我再帮你筛。",
      candidates: [],
      picks: emptyPicks(),
      profileSummary: context.memorySnapshot?.profileSummary ?? "",
    };
  }

  const userText = request.messages.at(-1)?.content ?? "";
  const profile = await getProfileMemory(request.userId).catch(() => null);

  // Convert menu candidates to ScoredCandidate[]
  const scored: ScoredCandidate[] = menuCandidates.map((c, i) => ({
    candidateId: c.candidateId || String(i + 1),
    menuIndex: i + 1,
    displayName: c.displayName,
    brewery: c.brewery || "",
    style: c.style || "",
    abv: c.abv || 0,
    price: c.price ?? null,
    volumeMl: null,
    worthScore: 0,
    fitScore: 0,
    riskFlags: [],
    reason: "",
    rating: c.rating ?? null,
    ratingsCount: null,
    source: "short_term",
  }));

  // Extract constraints from user text
  const constraints = extractConstraints(userText);

  // Filter by constraints
  let filtered = scored;
  if (constraints.length > 0) {
    filtered = scored.filter(c => {
      return constraints.every(ct => matchConstraint(c, ct));
    });
  }

  // If filter removed everything, show what's available with a note
  if (filtered.length === 0) {
    const names = scored.map(c => c.displayName).join("、");
    return {
      mode: "recommend",
      reply: `酒单上没有符合「${constraints.join("、")}」的酒。现有：${names}。要不要换个方向？`,
      candidates: scored.map(scoredToBeerCandidate),
      picks: emptyPicks(),
      profileSummary: profile?.summary ?? "",
    };
  }

  // Score, pick, reply using the same recommendation engine but only from menu items
  const scored2 = scoreCandidates(filtered, profile, constraints);
  const picks = selectPicks(scored2);
  const reply = buildRecommendationReply(picks, scored2);
  const candidates = scored2.map(scoredToBeerCandidate);

  return {
    mode: "recommend",
    reply,
    candidates,
    picks: {
      topPick: pickToPick(picks.topPick),
      safePick: pickToPick(picks.safePick),
      explorePick: pickToPick(picks.explorePick),
      avoidOrCaution: pickToPick(picks.avoidOrCaution),
    },
    profileSummary: profile?.summary ?? "",
  };
}

// ── Constraint extraction ──

function extractConstraints(text: string): string[] {
  const c: string[] = [];
  if (/IPA|ipa/i.test(text)) c.push("IPA");
  if (/拉格|lager|皮尔森|pils/i.test(text)) c.push("lager");
  if (/世涛|stout/i.test(text)) c.push("stout");
  if (/酸|sour|gose|柏林/i.test(text)) c.push("sour");
  if (/小麦|wheat|hefe|白啤/i.test(text)) c.push("wheat");
  if (/清爽|不苦|淡|light/i.test(text)) c.push("crisp");
  if (/烈|浓|重|imperial|double/i.test(text)) c.push("strong");
  if (/尝新|特别|奇怪|怪/i.test(text)) c.push("explore");
  if (/第一杯|开场/i.test(text)) c.push("first_beer");
  if (/配餐|下饭|吃饭/i.test(text)) c.push("with_food");
  return c;
}

function matchConstraint(c: ScoredCandidate, constraint: string): boolean {
  const style = (c.style || "").toLowerCase();
  const name = (c.displayName || "").toLowerCase();
  const s = `${style} ${name}`;
  const map: Record<string, RegExp> = {
    IPA: /ipa|pale ale/i,
    lager: /lager|pils|拉格|皮尔森/i,
    stout: /stout|世涛/i,
    sour: /sour|gose|酸|berliner|野菌|lambic|flemish/i,
    wheat: /wheat|hefe|wit|白啤|小麦/i,
    crisp: /pils|lager|pale|session|kolsch|拉格|皮尔森|清爽/i,
    strong: /imperial|double|triple|barrel|barley|帝国/i,
  };
  const re = map[constraint];
  if (re) return re.test(s);
  // For abstract constraints like "explore", "first_beer", "with_food", always match
  return true;
}

// ── Helpers ──

function scoredToBeerCandidate(s: ScoredCandidate): BeerCandidate {
  return {
    candidateId: s.candidateId,
    menuIndex: s.menuIndex,
    displayName: s.displayName,
    brewery: s.brewery,
    style: s.style,
    abv: s.abv,
    ibu: null,
    hops: [],
    worthScore: s.worthScore,
    fitScore: s.fitScore,
    riskFlags: s.riskFlags,
    reason: s.reason,
    evidence: [],
    price: s.price,
    volumeMl: s.volumeMl,
    untappdScore: s.rating,
    untappdRatingCount: s.ratingsCount,
  };
}

function pickToPick(p: { candidateId: string; label: string; reason: string; worthScore: number; fitScore: number }): Pick {
  return { candidateId: p.candidateId, label: p.label, reason: p.reason, worthScore: p.worthScore, fitScore: p.fitScore };
}
