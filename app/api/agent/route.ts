import { NextResponse } from "next/server";
import { runBeerAgent } from "@/lib/beer-agent/provider";
import type { AgentRequest } from "@/lib/beer-agent/types";
import type { PipelineEvent } from "@/lib/beer-agent/multi-stage-pipeline";

export const runtime = "nodejs";

function sseEvent(data: PipelineEvent): string {
  return `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseComment(text: string): string {
  return `: ${text}\n\n`;
}

export async function POST(request: Request) {
  const body = (await request.json()) as AgentRequest;
  const useStream = new URL(request.url).searchParams.get("stream") === "true";

  if (!useStream) {
    try {
      const result = await runBeerAgent(body);
      return NextResponse.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown beer agent error";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  // SSE streaming mode
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: string) => controller.enqueue(encoder.encode(data));

      try {
        // Send keepalive immediately
        send(sseComment("connected"));

        const result = await runBeerAgent(body, (event) => {
          send(sseEvent(event));
        });

        // Send final result
        send(`event: final\ndata: ${JSON.stringify(result)}\n\n`);
        controller.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        send(sseEvent({ type: "stage_error", stage: "fatal", error: message }));
        send(`event: fatal\ndata: ${JSON.stringify({ error: message })}\n\n`);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
