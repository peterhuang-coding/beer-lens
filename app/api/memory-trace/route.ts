import { NextResponse } from "next/server";
import { getFactors } from "@/lib/beer-agent/memory/factor/extraction";
import { getProfileMemory } from "@/lib/beer-agent/memory/profile";
import { getReflectionHistory } from "@/lib/beer-agent/memory/profile-reflection";
import { getTastingEpisodes } from "@/lib/beer-agent/memory/episodic";
import { isDebugRequestAllowed } from "@/lib/debug-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type") || "factors";
  const userId = searchParams.get("userId") || "local-user";

  try {
    switch (type) {
      case "factors":
        return NextResponse.json({ factors: await getFactors(userId) });
      case "profile":
        return NextResponse.json({ profile: await getProfileMemory(userId).catch(() => null) });
      case "reflection":
        return NextResponse.json({ reflections: await getReflectionHistory(userId) });
      case "episodes":
        return NextResponse.json({ episodes: await getTastingEpisodes(userId) });
      default:
        return NextResponse.json({ error: "unknown type" }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
