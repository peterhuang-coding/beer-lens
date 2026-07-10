import { NextResponse } from "next/server";
import { createBadcase, listBadcases } from "@/lib/beer-agent/badcases";
import type { BadcaseLabel } from "@/lib/beer-agent/badcases";
import { isDebugRequestAllowed } from "@/lib/debug-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { searchParams } = new URL(request.url);

  const status = searchParams.get("status");
  const label = searchParams.get("label");
  const traceId = searchParams.get("traceId");

  const filters: { status?: string; label?: string; traceId?: string } = {};
  if (status) filters.status = status;
  if (label) filters.label = label;
  if (traceId) filters.traceId = traceId;

  const hasFilters = Object.keys(filters).length > 0;
  const badcases = await listBadcases(hasFilters ? filters : undefined);
  return NextResponse.json(badcases);
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      traceId: string;
      label: string;
      note?: string;
      expected?: {
        intent?: string;
        beerName?: string;
        reply?: string;
      };
    };

    if (!body.traceId || !body.label) {
      return NextResponse.json(
        { ok: false, error: "traceId and label are required" },
        { status: 400 }
      );
    }

    const result = await createBadcase({
      traceId: body.traceId,
      label: body.label as BadcaseLabel,
      note: body.note,
      expected: body.expected,
    });

    return NextResponse.json(result, { status: result.badcase ? 201 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
