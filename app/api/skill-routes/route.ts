import { NextResponse } from "next/server";
import { getRouteTable, reloadRouteTable } from "@/lib/beer-agent/route-registry";
import { isDebugRequestAllowed } from "@/lib/debug-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  reloadRouteTable();
  return NextResponse.json(getRouteTable());
}
