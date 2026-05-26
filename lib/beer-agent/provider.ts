import type { AgentRequest, AgentResponse } from "./types";
import { runMockBeerAgent } from "./mock-provider";
import { runOpenRouterBeerAgent } from "./openrouter-provider";

export async function runBeerAgent(request: AgentRequest): Promise<AgentResponse> {
  if (process.env.BEER_AGENT_API_URL) {
    return callExternalBeerAgent(request);
  }

  if (process.env.OPENROUTER_API_KEY) {
    return runOpenRouterBeerAgent(request);
  }

  return runMockBeerAgent(request);
}

async function callExternalBeerAgent(request: AgentRequest): Promise<AgentResponse> {
  const response = await fetch(process.env.BEER_AGENT_API_URL as string, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.BEER_AGENT_API_KEY
        ? { authorization: `Bearer ${process.env.BEER_AGENT_API_KEY}` }
        : {})
    },
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    throw new Error(`Beer agent API failed: ${response.status}`);
  }

  return response.json() as Promise<AgentResponse>;
}
