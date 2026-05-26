import type { AgentRequest, AgentResponse, BeerCandidate } from "./types";
import { benchmarkQuestions, parseBenchmark } from "./benchmark";
import { appendJournalEntry, getProfileSummary } from "./profile";
import { enrichBeer } from "./beer-db/enricher";

const mockCandidates: BeerCandidate[] = [
  {
    candidateId: "green-city",
    menuIndex: 3,
    displayName: "3 号 Green City",
    brewery: "Other Half Brewing",
    style: "Hazy IPA",
    abv: 7,
    hops: ["Citra", "Mosaic", "Centennial"],
    worthScore: 94,
    fitScore: 91,
    riskFlags: ["freshness_unknown"],
    reason: "热带水果、低苦度、7% 左右，最贴近冷启动偏好，也适合作为今晚主推。",
    evidence: [
      {
        source: "agent_inference",
        summary: "用户偏好尚少，先按热带水果、柑橘、清爽、低甜度作为冷启动偏好。",
        confidence: 0.72
      }
    ]
  },
  {
    candidateId: "pivo-pils",
    menuIndex: 2,
    displayName: "2 号 Pivo Pils",
    brewery: "Firestone Walker",
    style: "German Pilsner",
    abv: 5.3,
    hops: ["Saphir", "Spalter Select"],
    worthScore: 86,
    fitScore: 80,
    riskFlags: [],
    reason: "清爽、干净、收口利落，是第一杯或者不想冒险时的稳妥选择。",
    evidence: [
      {
        source: "agent_inference",
        summary: "Pilsner 风格通常低风险，适合用户说想清爽或不要太苦时推荐。",
        confidence: 0.78
      }
    ]
  },
  {
    candidateId: "oude-geuze",
    menuIndex: 6,
    displayName: "6 号 Oude Geuze",
    brewery: "Boon",
    style: "Lambic / Gueuze",
    abv: 7,
    hops: ["Aged hops"],
    worthScore: 89,
    fitScore: 58,
    riskFlags: ["polarizing_flavor", "likely_too_sour"],
    reason: "经典、值得尝新，但酸、野菌、皮革气息明显，个人适配风险高。",
    evidence: [
      {
        source: "agent_inference",
        summary: "高酸和野菌类风味对新用户更分化，应作为尝鲜选择而非默认 top pick。",
        confidence: 0.7
      }
    ]
  }
];

export async function runMockBeerAgent(request: AgentRequest): Promise<AgentResponse> {
  const lastUserMessage = request.messages.at(-1)?.content ?? "";
  const profileSummary = await getProfileSummary();

  if (request.mode === "benchmark" || looksLikeBenchmark(lastUserMessage)) {
    const entry = parseBenchmark(lastUserMessage);
    await appendJournalEntry(entry);
    const nextProfile = await getProfileSummary();

    return {
      mode: "benchmark",
      reply: `记下来了。${entry.parsed.overallScore ? `这杯是 ${entry.parsed.overallScore}/5。` : ""}${
        entry.parsed.wouldDrinkAgain ? ` 下次是否再点：${entry.parsed.wouldDrinkAgain}。` : ""
      }\n\n我已经把这些信号写入口味画像：${[
        ...entry.parsed.aromaTags,
        ...entry.parsed.tasteTags,
        ...entry.parsed.contextTags
      ].join("、") || "暂无明确标签"}。\n\n${nextProfile}`,
      candidates: [],
      picks: buildPicks(mockCandidates),
      benchmarkPrompt: benchmarkQuestions,
      profileSummary: nextProfile
    };
  }

  const adjusted = adjustCandidatesForIntent(mockCandidates, lastUserMessage);
  const candidates = await Promise.all(adjusted.map(enrichMockCandidate));
  const picks = buildPicks(candidates);

  return {
    mode: "recommend",
    reply: buildRecommendationReply(candidates, picks, Boolean(request.image), profileSummary),
    candidates,
    picks,
    benchmarkPrompt: benchmarkQuestions,
    profileSummary
  };
}

async function enrichMockCandidate(candidate: BeerCandidate): Promise<BeerCandidate> {
  try {
    const enriched = await enrichBeer({
      beerName: candidate.displayName.replace(/^\d+\s*[号#]\s*/, "").trim() || candidate.displayName,
      brewery: candidate.brewery,
      style: candidate.style,
      abv: candidate.abv,
      hops: candidate.hops,
    });
    return {
      ...candidate,
      untappdId: enriched.untappdId,
      untappdScore: enriched.untappdScore,
      untappdRatingCount: enriched.untappdRatingCount,
      untappdUrl: enriched.untappdUrl,
      breweryCountry: enriched.breweryCountry,
      labelImage: enriched.labelImage,
    };
  } catch {
    return candidate;
  }
}

function looksLikeBenchmark(input: string) {
  return /\b[1-5](?:\.\d+)?\s*分\b/.test(input)
    || input.includes("会再喝")
    || input.includes("不会再喝");
}

function adjustCandidatesForIntent(candidates: BeerCandidate[], intent: string) {
  return candidates
    .map((candidate) => {
      let fitScore = candidate.fitScore;
      let worthScore = candidate.worthScore;

      if (intent.includes("清爽") && candidate.style.includes("Pilsner")) fitScore += 20;
      if (intent.includes("不要太苦") && candidate.style.includes("IPA")) fitScore -= 4;
      if (intent.includes("尝新") && candidate.style.includes("Lambic")) fitScore += 16;
      if (intent.includes("稳") && candidate.style.includes("Pilsner")) fitScore += 12;
      if (intent.includes("酸") && candidate.style.includes("Lambic")) fitScore += 14;
      if (intent.includes("高分") || intent.includes("最好")) worthScore += 3;

      return {
        ...candidate,
        fitScore: clamp(fitScore),
        worthScore: clamp(worthScore)
      };
    })
    .sort((left, right) => right.fitScore + right.worthScore - (left.fitScore + left.worthScore));
}

function buildPicks(candidates: BeerCandidate[]) {
  const top = candidates[0];
  const safe = candidates.find((candidate) => candidate.style.includes("Pilsner")) ?? top;
  const explore = candidates.find((candidate) => candidate.style.includes("Lambic")) ?? top;
  const caution =
    [...candidates].sort((left, right) => left.fitScore - right.fitScore)[0] ?? candidates[0];

  return {
    topPick: toPick(top, "如果只能喝一杯"),
    safePick: toPick(safe, "最稳"),
    explorePick: toPick(explore, "最值得尝新"),
    avoidOrCaution: toPick(caution, "我会谨慎")
  };
}

function toPick(candidate: BeerCandidate, label: string) {
  return {
    candidateId: candidate.candidateId,
    label,
    reason: candidate.reason,
    worthScore: candidate.worthScore,
    fitScore: candidate.fitScore
  };
}

function buildRecommendationReply(
  candidates: BeerCandidate[],
  picks: ReturnType<typeof buildPicks>,
  hasImage: boolean,
  profileSummary: string
) {
  const scanLine = hasImage
    ? "我先按你发的图片做酒单识别和推荐；当前 OCR/外部检索先走 mock，后面可以接你的 API。"
    : "我先按你给的文字做推荐；如果你发酒单照片，我会把候选酒列出来再排序。";

  return `${scanLine}

我会这样点：

1. ${candidates[0].displayName} - ${candidates[0].reason}
2. ${candidates[1].displayName} - ${candidates[1].reason}
3. ${candidates[2].displayName} - ${candidates[2].reason}

最稳：${candidateName(candidates, picks.safePick.candidateId)}，${picks.safePick.reason}
最值得尝新：${candidateName(candidates, picks.explorePick.candidateId)}，${picks.explorePick.reason}
我会先跳过或谨慎：${candidateName(candidates, picks.avoidOrCaution.candidateId)}，${picks.avoidOrCaution.reason}

如果你只能喝一杯，选 ${candidates[0].displayName}。

当前画像：${profileSummary}`;
}

function candidateName(candidates: BeerCandidate[], candidateId: string) {
  return candidates.find((candidate) => candidate.candidateId === candidateId)?.displayName ?? "这款";
}

function clamp(score: number) {
  return Math.max(0, Math.min(100, Math.round(score)));
}
