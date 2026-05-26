import type { AgentRequest, AgentResponse } from "./types";
import { runOpenRouterBeerAgent } from "./openrouter-provider";
import { runMultiStagePipeline } from "./multi-stage-pipeline";
import { getProfileSummary } from "./profile";
import { enrichBeer } from "./beer-db/enricher";
import { benchmarkQuestions } from "./benchmark";

export async function runBeerAgent(request: AgentRequest): Promise<AgentResponse> {
  if (process.env.BEER_AGENT_API_URL) {
    return callExternalBeerAgent(request);
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("请在 .env.local 中配置 OPENROUTER_API_KEY，当前无任何后端模型可用。");
  }

  // Multi-stage pipeline: for image inputs, use 4-stage OCR pipeline
  if (request.image?.dataUrl) {
    const lastUserMessage = request.messages.at(-1)?.content ?? "";
    const profileSummary = await getProfileSummary();
    return runImagePipeline(apiKey, request.image.dataUrl, lastUserMessage, profileSummary);
  }

  // Text-only
  return runOpenRouterBeerAgent(request);
}

async function runImagePipeline(
  apiKey: string,
  imageDataUrl: string,
  userText: string,
  profileSummary: string
): Promise<AgentResponse> {
  const pipeline = await runMultiStagePipeline({
    apiKey,
    imageDataUrl,
    userText,
    profile: profileSummary,
  });

  const candidates = await Promise.all(
    (pipeline.recommendation.candidates ?? []).map(async (c) => {
      let enriched = { ...c, price: null as number | null, volumeMl: null as number | null };
      try {
        const untappd = await enrichBeer({
          beerName: c.displayName,
          brewery: c.brewery,
          style: c.style,
          abv: c.abv,
          hops: c.hops,
          price: (c as any).price ?? undefined,
          volumeMl: (c as any).volumeMl ?? undefined,
        });
        enriched = {
          ...c,
          untappdId: untappd.untappdId,
          untappdScore: untappd.untappdScore,
          untappdRatingCount: untappd.untappdRatingCount,
          untappdUrl: untappd.untappdUrl,
          breweryCountry: untappd.breweryCountry,
          labelImage: untappd.labelImage,
          price: untappd.price,
          volumeMl: untappd.volumeMl,
          pricePerMl: untappd.pricePerMl,
          valueScore: untappd.valueScore,
        };
      } catch { /* enrichment failed, continue with raw candidate */ }
      return enriched;
    })
  );

  const sorted = candidates.sort(
    (a, b) => b.fitScore + b.worthScore - (a.fitScore + a.worthScore)
  );

  const top = sorted[0];
  const safe = sorted.find((c) => /pils|lager|pale|小麦|拉格|皮尔森/i.test(c.style)) ?? top;
  const explore = sorted.find((c) => c.riskFlags?.length > 0 || c.fitScore < 70) ?? top;
  const caution = [...sorted].sort((a, b) => a.fitScore - b.fitScore)[0] ?? top;

  return {
    mode: "recommend",
    reply: pipeline.recommendation.reply,
    candidates: sorted,
    picks: {
      topPick: toPick(top, "如果只能喝一杯"),
      safePick: toPick(safe, "最稳"),
      explorePick: toPick(explore, "最值得尝新"),
      avoidOrCaution: toPick(caution, "我会谨慎"),
    },
    benchmarkPrompt: benchmarkQuestions,
    profileSummary,
    stages: {
      imageContext: pipeline.imageContext ?? undefined,
      extracted: pipeline.extracted ?? undefined,
      visualQuality: pipeline.visualQuality ?? undefined,
    },
  };
}

function toPick(candidate: any, label: string) {
  return {
    candidateId: candidate.candidateId,
    label,
    reason: candidate.reason,
    worthScore: candidate.worthScore,
    fitScore: candidate.fitScore,
  };
}

async function callExternalBeerAgent(request: AgentRequest): Promise<AgentResponse> {
  const response = await fetch(process.env.BEER_AGENT_API_URL as string, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.BEER_AGENT_API_KEY
        ? { authorization: `Bearer ${process.env.BEER_AGENT_API_KEY}` }
        : {}),
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`Beer agent API failed: ${response.status}`);
  }

  return response.json() as Promise<AgentResponse>;
}
