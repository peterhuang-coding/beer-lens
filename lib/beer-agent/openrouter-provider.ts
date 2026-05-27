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
  const hasImage = !!request.image?.dataUrl;

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
  const systemPrompt = await buildSystemPrompt(profileSummary, hasImage);
  const userContent = buildUserContent(request, lastUserMessage);

  const raw = await callOpenRouter(apiKey, systemPrompt, userContent);

  const parsed = parseAgentJson(raw);

  if (!parsed) {
    return {
      mode: "recommend",
      reply: raw.trim() || "请先发一张酒单照片给我。",
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

async function buildSystemPrompt(profileSummary: string, hasImage: boolean) {
  const promptPath = path.join(process.cwd(), "docs", "agent", "system-prompt.md");
  const basePrompt = await readFile(promptPath, "utf8").catch(() => "");

  const modeInstruction = hasImage
    ? `MODE: IMAGE ANALYSIS. You have a beer menu photo. Extract real beers from it. Return candidates for each beer you can read.`
    : `MODE: TEXT FOLLOW-UP. No new image. You MUST return "candidates": [].

CRITICAL: First, scan the conversation history. If the assistant previously listed real beers from a menu (with names, breweries, Untappd scores), THOSE are your beer pool. Reference them by name in your reply. Filter/rank them based on what the user is asking for.

If there are NO previously scanned beers in the conversation, tell the user to upload a menu photo.

NEVER invent fake beer names, breweries, or scores.`;

  return `${basePrompt}

You must return valid JSON only. Do not wrap it in markdown.

${modeInstruction}

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

  const hasImage = !!request.image?.dataUrl;

  let text: string;
  if (hasImage) {
    text = `User uploaded a beer menu photo. Extract ALL beers from it with prices, volumes, breweries, and styles.

User request: ${lastUserMessage || "请识别酒单并推荐。"}

Recent chat:
${history}`;
  } else {
    // Extract beer names from recent assistant messages
    const beerNames = extractBeerNamesFromHistory(request.messages);

    if (beerNames.length > 0) {
      text = `TEXT FOLLOW-UP (no new image).

The user previously uploaded a menu. The following real beers were found:
${beerNames.map((b, i) => `${i + 1}. ${b}`).join("\n")}

User's new request: ${lastUserMessage}

YOUR TASK: Filter and re-rank from the above list ONLY. If some beers match the user's request, recommend the best ones by name. If NO beers match (e.g., user asks for stout but list only has IPAs), honestly say none match and suggest the closest option. Do NOT ask the user to upload another menu — they already did. Return "candidates": [].

Recent chat:
${history}`;
    } else {
      text = `TEXT FOLLOW-UP (no new image, no prior menu).

User request: ${lastUserMessage}

No menu has been uploaded yet. Tell the user to upload a menu photo. Return "candidates": [].

Recent chat:
${history}`;
    }
  }

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

// Simple heuristic: extract lines that look like "name - brewery, style, ABV%" from history
function extractBeerNamesFromHistory(messages: Array<{ role: string; content: string }>): string[] {
  const names: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    // Match patterns like "1. Beer Name / English Name - Brewery, Style, X%"
    const matches = msg.content.matchAll(/\d+\.\s*(.+?)(?:\s*[-–—]\s*[^,\n]+(?:,|\n|$))/g);
    for (const m of matches) {
      const name = m[1].trim();
      if (name && !names.includes(name) && name.length > 2) {
        names.push(name);
      }
    }
  }
  return names.slice(0, 30); // cap at 30
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
