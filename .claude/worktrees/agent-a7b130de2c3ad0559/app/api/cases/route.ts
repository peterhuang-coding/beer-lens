import { NextResponse } from "next/server";
import { createCaseFromTrace, listCases, updateCase } from "@/lib/beer-agent/cases";
import { isDebugRequestAllowed } from "@/lib/debug-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { searchParams } = new URL(request.url);
  const filters: { status?: string; label?: string } = {};
  if (searchParams.get("status")) filters.status = searchParams.get("status")!;
  if (searchParams.get("label")) filters.label = searchParams.get("label")!;
  const cases = await listCases(filters);
  return NextResponse.json(cases);
}
