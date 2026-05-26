import { readFile } from "node:fs/promises";
import path from "node:path";
import { benchmarkQuestions, parseBenchmark } from "./benchmark";
import { appendJournalEntry, getProfileSummary } from "./profile";
import { enrichBeer } from "./beer-db/enricher";
import { openrouterFetch } from "./openrouter-client";
import type { AgentRequest, AgentResponse, BeerCandidate } from "./types";

const fallbackModel = "openai/gpt-4o-mini";

export async function runOpenRouterBeerAgent(request: AgentRequest): Promise<AgentResponse> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY not configured");
  }

  const lastUserMessage = request.messages.at(-1)?.content ?? "";

  if (request.mode === "benchmark" || looksLikeBenchmark(lastUserMessage)) {
    const entry = parseBenchmark(lastUserMessage);
    await appendJournalEntry(entry);
    const profileSummary = await getProfileSummary();

    return {
      mode: "benchmark",
      reply: `记下来了。${entry.parsed.overallScore ? `这杯是 ${entry.parsed.overallScore}/5。` : ""}${
        entry.parsed.wouldDrinkAgain ? ` 下次是否再点：${entry.parsed.wouldDrinkAgain}。` : ""
      }\n\n我已经写入口味库。${profileSummary}`,
      candidates: [],
      picks: {
        topPick: emptyPick(),
        safePick: emptyPick(),
        explorePick: emptyPick(),
        avoidOrCaution: emptyPick(),
      },
      profileSummary,
      benchmarkPrompt: benchmarkQuestions,
    };
  }

  const profileSummary = await getProfileSummary();
  const systemPrompt = await buildSystemPrompt(profileSummary);
  const userContent = buildUserContent(request, lastUserMessage);

  const raw = await callOpenRouter(apiKey, systemPrompt, userContent);

  const parsed = parseAgentJson(raw);

  if (!parsed) {
    return {
      mode: "recommend",
      reply: `${raw}\n\n⚠ 模型输出无法解析为结构化 JSON，以上为原始回复。`,
      candidates: [],
      picks: {
        topPick: emptyPick(),
        safePick: emptyPick(),
        explorePick: emptyPick(),
        avoidOrCaution: emptyPick(),
      },
      profileSummary,
    };
  }

  return normalizeAgentResponse(parsed, profileSummary);
}

function looksLikeBenchmark(input: string) {
  return /\b[1-5](?:\.\d+)?\s*分\b/.test(input)
    || input.includes("会再喝")
    || input.includes("不会再喝");
}

async function buildSystemPrompt(profileSummary: string) {
  const promptPath = path.join(process.cwd(), "docs", "agent", "system-prompt.md");
  const basePrompt = await readFile(promptPath, "utf8").catch(() => "");

  return `${basePrompt}

You must return valid JSON only. Do not wrap it in markdown.

The JSON shape must be:
{
  "reply": "Chinese human-readable recommendation",
  "candidates": [
    {
      "candidateId": "string",
      "menuIndex": 1,
      "displayName": "string",
      "brewery": "string",
      "style": "string",
      "abv": 0,
      "hops": ["string"],
      "price": null,
      "volumeMl": null,
      "worthScore": 0,
      "fitScore": 0,
      "riskFlags": ["string"],
      "reason": "string",
      "evidence": [
        { "source": "agent_inference", "summary": "string", "confidence": 0.7 }
      ]
    }
  ]
}

Important: "price" is the raw price from the menu (number, in RMB/元), and "volumeMl" is the serving size in ml (number). Both can be null if not visible.

Current user profile:
${profileSummary}
`;
}

function buildUserContent(request: AgentRequest, lastUserMessage: string) {
  const history = request.messages
    .slice(-8)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");

  const text = `User request:
${lastUserMessage || "用户上传了图片，请识别酒单并推荐。"}

Recent chat:
${history}

If an image is present, inspect it as a beer menu or beer label. If text is unreadable, say confidence is low and ask for a closer crop.`;

  if (!request.image?.dataUrl) {
    return text;
  }

  return [
    { type: "text", text },
    {
      type: "image_url",
      image_url: {
        url: request.image.dataUrl
      }
    }
  ];
}

async function callOpenRouter(
  _apiKey: string,
  systemPrompt: string,
  userContent: string | object[]
) {
  return openrouterFetch({
    model: process.env.OPENROUTER_MODEL ?? fallbackModel,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    temperature: 0.2,
    max_tokens: 1800,
  });
}

function parseAgentJson(raw: string) {
  try {
    return JSON.parse(raw) as Partial<AgentResponse>;
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as Partial<AgentResponse>;
    } catch {
      return null;
    }
  }
}

async function normalizeAgentResponse(
  parsed: Partial<AgentResponse>,
  profileSummary: string
): Promise<AgentResponse> {
  const rawCandidates = (parsed.candidates ?? []).map(normalizeCandidate);
  const enriched = await Promise.all(
    rawCandidates.map(enrichCandidate)
  );
  const sorted = enriched.sort(
    (left, right) => right.fitScore + right.worthScore - (left.fitScore + left.worthScore)
  );

  const top = sorted[0] ?? emptyCandidate();
  const safe =
    sorted.find((candidate) => /pils|lager|pale|小麦|拉格|皮尔森/i.test(candidate.style)) ?? top;
  const explore =
    sorted.find((candidate) => candidate.riskFlags.length > 0 || candidate.fitScore < 70) ?? top;
  const caution = [...sorted].sort((left, right) => left.fitScore - right.fitScore)[0] ?? top;

  return {
    mode: "recommend",
    reply: parsed.reply ?? "我已经读完输入，但模型没有给出完整中文推荐。",
    candidates: sorted,
    picks: {
      topPick: toPick(top, "如果只能喝一杯"),
      safePick: toPick(safe, "最稳"),
      explorePick: toPick(explore, "最值得尝新"),
      avoidOrCaution: toPick(caution, "我会谨慎")
    },
    benchmarkPrompt: benchmarkQuestions,
    profileSummary
  };
}

function normalizeCandidate(candidate: Partial<BeerCandidate>): BeerCandidate {
  return {
    candidateId: String(candidate.candidateId ?? `candidate_${Math.random().toString(36).slice(2)}`),
    menuIndex: Number(candidate.menuIndex ?? 0),
    displayName: String(candidate.displayName ?? "Unknown beer"),
    brewery: String(candidate.brewery ?? "Unknown brewery"),
    style: String(candidate.style ?? "Unknown style"),
    abv: Number(candidate.abv ?? 0),
    ibu: candidate.ibu ?? null,
    hops: Array.isArray(candidate.hops) ? candidate.hops.map(String) : [],
    price: candidate.price ?? null,
    volumeMl: candidate.volumeMl ?? null,
    worthScore: clamp(Number(candidate.worthScore ?? 50)),
    fitScore: clamp(Number(candidate.fitScore ?? 50)),
    riskFlags: Array.isArray(candidate.riskFlags) ? candidate.riskFlags.map(String) : [],
    reason: String(candidate.reason ?? "信息不足，需要更多上下文。"),
    evidence: Array.isArray(candidate.evidence) ? candidate.evidence : []
  };
}

async function enrichCandidate(candidate: BeerCandidate): Promise<BeerCandidate> {
  try {
    const enriched = await enrichBeer({
      beerName: candidate.displayName.replace(/^\d+\s*[号#]\s*/, "").trim() || candidate.displayName,
      brewery: candidate.brewery,
      style: candidate.style,
      abv: candidate.abv,
      hops: candidate.hops,
      price: candidate.price ?? undefined,
      volumeMl: candidate.volumeMl ?? undefined,
    });

    return {
      ...candidate,
      untappdId: enriched.untappdId,
      untappdScore: enriched.untappdScore,
      untappdRatingCount: enriched.untappdRatingCount,
      untappdUrl: enriched.untappdUrl,
      breweryCountry: enriched.breweryCountry,
      labelImage: enriched.labelImage,
      price: enriched.price,
      volumeMl: enriched.volumeMl,
      pricePerMl: enriched.pricePerMl,
      valueScore: enriched.valueScore,
      worthScore: enriched.untappdScore
        ? clamp(Math.round(candidate.worthScore * 0.6 + enriched.untappdScore * 20 * 0.4))
        : candidate.worthScore,
    };
  } catch {
    return candidate;
  }
}

function emptyCandidate(): BeerCandidate {
  return {
    candidateId: "empty",
    menuIndex: 0,
    displayName: "等待候选酒",
    brewery: "Unknown brewery",
    style: "Unknown style",
    abv: 0,
    hops: [],
    worthScore: 0,
    fitScore: 0,
    riskFlags: [],
    reason: "还没有足够信息。",
    evidence: [],
    price: null,
    volumeMl: null,
  };
}

function emptyPick() {
  return {
    candidateId: "empty",
    label: "暂无",
    reason: "暂无推荐",
    worthScore: 0,
    fitScore: 0,
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

function clamp(score: number) {
  return Math.max(0, Math.min(100, Math.round(score)));
}
