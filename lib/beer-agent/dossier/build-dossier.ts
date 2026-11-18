import type { BeerCandidate } from "../types";
import {
  getSupplementGrounding,
  type MenuSupplementEntry,
  type MenuSupplementSource,
} from "../menu-supplements";
import { getStyleKnowledge } from "./style-knowledge";
import type {
  BeerDossier,
  Claim,
  DossierSource,
  IdentityStatus,
  Reputation,
} from "./types";

type FactField = "hops" | "ingredients" | "sensory" | "process" | "reputation";
type StructuredFact = { values: unknown[]; sources: number[]; excerpt?: string };

const FACT_SOURCE_FIELDS: Record<FactField, string[]> = {
  hops: ["hops"],
  ingredients: ["ingredients"],
  sensory: ["flavor_notes", "community_sensory_description", "description"],
  process: ["process", "barrel_aging"],
  reputation: ["producer_description", "reputation"],
};

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:T|\b)/.test(text)) return false;
  return Number.isFinite(Date.parse(text));
}

function sourceClaim<T>(
  source: MenuSupplementSource,
  value: T,
  excerpt?: string,
): Claim<T> {
  return {
    value,
    source: "social_web",
    sourceKind: source.kind,
    url: source.url,
    access: source.access,
    ...(excerpt ? { excerpt } : {}),
    checkedAt: source.checked_at,
    reviewStatus: "curated",
    usable: true,
  };
}

function supportingSource(
  entry: MenuSupplementEntry,
  fields: string[],
  preferred?: string,
): MenuSupplementSource | null {
  const supported = entry.sources.filter(source => fields.some(field => source.fields.includes(field)));
  if (preferred) {
    const normalized = preferred.toLowerCase();
    const exact = supported.find(source => source.url.toLowerCase().includes(normalized));
    if (exact) return exact;
  }
  return supported[0] ?? null;
}

function structuredFact(
  entry: MenuSupplementEntry,
  field: FactField,
): { fact: StructuredFact; source: MenuSupplementSource } | null {
  const fact = entry.sourced_facts?.[field] as StructuredFact | undefined;
  if (!fact || !Array.isArray(fact.values) || fact.values.length === 0 ||
      !Array.isArray(fact.sources) || fact.sources.length === 0) return null;
  if (!fact.sources.every(index => Number.isInteger(index) && index >= 0 && index < entry.sources.length)) return null;
  const sources = fact.sources.map(index => entry.sources[index]);
  const allowed = FACT_SOURCE_FIELDS[field];
  if (!sources.every(source => allowed.some(name => source.fields.includes(name)))) return null;
  return { fact, source: sources[0] };
}

function stringFact(entry: MenuSupplementEntry, field: Exclude<FactField, "reputation">): Claim<string[]> | null {
  const resolved = structuredFact(entry, field);
  if (!resolved) return null;
  const values = resolved.fact.values.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map(value => value.trim());
  if (values.length !== resolved.fact.values.length) return null;
  return sourceClaim(resolved.source, [...new Set(values)], resolved.fact.excerpt);
}

function explicitObservation(candidate: BeerCandidate, kind: "abv" | "style"): {
  value: number | string;
  source: "ocr" | "manual_user_input";
} | null {
  const pattern = kind === "abv"
    ? /(?:菜单转录明示 ABV|菜单明示酒精度)\s*([0-9]+(?:\.[0-9]+)?)\s*%/
    : /菜单转录明示风格\s+(.+?)（菜单转录观察/;
  for (const evidence of candidate.evidence ?? []) {
    if (evidence.source !== "ocr" && evidence.source !== "manual_user_input") continue;
    const match = pattern.exec(evidence.summary ?? "");
    if (!match) continue;
    if (kind === "abv") {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value >= 0 && value <= 100) return { value, source: evidence.source };
    } else if (match[1].trim()) {
      return { value: match[1].trim(), source: evidence.source };
    }
  }
  return null;
}

function observationClaim<T>(candidate: BeerCandidate, value: T, source: DossierSource): Claim<T> {
  return {
    value,
    source,
    access: source === "ocr" || source === "manual_user_input" ? "menu_transcription" : "local_snapshot",
    reviewStatus: "unreviewed",
    usable: true,
  };
}

function buildStyle(candidate: BeerCandidate, entry: MenuSupplementEntry | null, confirmed: boolean) {
  const observed = explicitObservation(candidate, "style");
  if (confirmed && entry?.style) {
    const source = supportingSource(entry, ["style"]);
    if (source) return sourceClaim(source, entry.style);
  }
  if (observed && typeof observed.value === "string") {
    return observationClaim(candidate, observed.value, observed.source);
  }
  if (!entry && candidate.style.trim()) {
    const oldRecord = candidate.evidence.some(evidence => evidence.source === "untappd" ||
      (evidence.source === "agent_inference" && /本地 \S+ 酒款记录：/.test(evidence.summary)));
    if (oldRecord) return observationClaim(candidate, candidate.style.trim(), "legacy_db");
  }
  return null;
}

function abvSourceForKey(entry: MenuSupplementEntry, key: string): MenuSupplementSource | null {
  const preferred: Record<string, string> = {
    beeradvocate: "beeradvocate",
    tavour: "tavour",
    systembolaget: "systembolaget",
  };
  if (key === "brewery_order_page") {
    return entry.sources.find(source => source.kind === "brewery" && source.fields.includes("abv")) ?? null;
  }
  return supportingSource(entry, ["abv", "generic_abv"], preferred[key]);
}

function buildAbv(candidate: BeerCandidate, entry: MenuSupplementEntry | null, confirmed: boolean): BeerDossier["abv"] {
  const observations: Claim<number>[] = [];
  const seen = new Set<string>();
  const add = (claim: Claim<number> | null) => {
    if (!claim || !Number.isFinite(claim.value) || claim.value < 0 || claim.value > 100) return;
    const key = `${claim.source}:${claim.url ?? ""}:${claim.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    observations.push(claim);
  };

  const observed = explicitObservation(candidate, "abv");
  if (observed && typeof observed.value === "number") {
    add(observationClaim(candidate, observed.value, observed.source));
  }

  if (confirmed && entry) {
    const disagreement = entry.field_disagreements?.abv;
    const record = disagreement && typeof disagreement === "object"
      ? disagreement as Record<string, unknown> : {};
    for (const [key, value] of Object.entries(record)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      if (key === "menu_observation") {
        const source = observed?.source ?? "ocr";
        add({ ...observationClaim(candidate, value, source), checkedAt: entry.observation.observed_at });
      } else {
        const source = abvSourceForKey(entry, key);
        if (source) add(sourceClaim(source, value));
      }
    }
    if (typeof entry.abv === "number") {
      const source = supportingSource(entry, ["abv"]);
      if (source) add(sourceClaim(source, entry.abv));
    }
  } else if (!entry && !observed && candidate.abv > 0) {
    const oldRecord = candidate.evidence.some(evidence => evidence.source === "untappd" ||
      (evidence.source === "agent_inference" && /本地 \S+ 酒款记录：/.test(evidence.summary)));
    if (oldRecord) add(observationClaim(candidate, candidate.abv, "legacy_db"));
  }

  const resolutionValue = entry?.field_disagreements?.abv;
  const resolution = resolutionValue && typeof resolutionValue === "object"
    ? String((resolutionValue as Record<string, unknown>).resolution ?? "") || null : null;
  const distinctValues = new Set(observations.map(claim => claim.value));
  return {
    observations,
    conflicted: distinctValues.size > 1 && resolution !== "one_decimal_rounding",
    resolution,
  };
}

function buildRating(candidate: BeerCandidate, entry: MenuSupplementEntry | null, status: IdentityStatus): BeerDossier["rating"] {
  // Version/batch-unresolved rows must not expose a curated score snapshot,
  // even when a supplement entry carries one for a candidate version.
  if (status === "version_unresolved" || status === "batch_unresolved") return null;
  if (entry?.rating) {
    const { score, count, url, checked_at } = entry.rating;
    if (Number.isFinite(score) && score >= 0 && score <= 5 &&
        Number.isInteger(count) && count >= 0 && /^https:\/\//.test(url) && validDate(checked_at)) {
      return {
        value: { score, count },
        source: "untappd",
        sourceKind: "community",
        url,
        access: "web_index_or_cache",
        checkedAt: checked_at,
        reviewStatus: "curated",
        usable: true,
      };
    }
  }
  if (entry) return null;
  const score = candidate.untappdScore;
  const count = candidate.untappdRatingCount;
  const url = candidate.untappdUrl?.trim();
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 5 ||
      typeof count !== "number" || !Number.isInteger(count) || count < 0 ||
      !url || !/^https:\/\//.test(url) || !validDate(candidate.ratingCheckedAt)) return null;
  return {
    value: { score, count },
    source: "untappd",
    sourceKind: "community",
    url,
    access: "dated_local_snapshot",
    checkedAt: candidate.ratingCheckedAt,
    reviewStatus: "curated",
    usable: true,
  };
}

function buildReputation(entry: MenuSupplementEntry | null, confirmed: boolean): BeerDossier["brewery"] {
  const reputation: Claim<Reputation>[] = [];
  if (confirmed && entry) {
    const resolved = structuredFact(entry, "reputation");
    if (resolved) {
      for (const value of resolved.fact.values) {
        if (value === null || typeof value !== "object") continue;
        const candidate = value as Record<string, unknown>;
        if (!["classic", "flagship", "award", "community"].includes(String(candidate.kind)) ||
            typeof candidate.text !== "string" || !candidate.text.trim()) continue;
        reputation.push(sourceClaim(resolved.source, {
          kind: candidate.kind as Reputation["kind"],
          text: candidate.text.trim(),
        }, resolved.fact.excerpt));
      }
    }
  }
  const flagship = reputation.find(claim => claim.value.kind === "flagship") ?? null;
  return {
    flagship: {
      status: flagship ? "sourced" : "unproven",
      beer: flagship ? entry?.canonical_name ?? entry?.menu_name ?? null : null,
      claim: flagship,
    },
    reputation,
  };
}

export function buildBeerDossier(
  candidate: BeerCandidate,
  entries: MenuSupplementEntry[] = [],
): BeerDossier {
  const grounding = getSupplementGrounding(candidate);
  const entry = grounding ? entries.find(item => item.id === grounding.entryId) ?? null : null;
  const evidenceStatus = grounding?.identityStatus;
  const entryStatus = entry?.identity_status;
  const unresolved = [evidenceStatus, entryStatus].find(status =>
    status === "version_unresolved" || status === "batch_unresolved");
  const identityStatus: IdentityStatus = unresolved ?? (entry?.identity_status ?? evidenceStatus ?? "unmatched");
  const confirmed = identityStatus === "confirmed" && entry?.identity_status === "confirmed" &&
    grounding?.identityStatus === "confirmed";
  const style = buildStyle(candidate, entry, confirmed);
  const sensory = confirmed && entry ? stringFact(entry, "sensory") : null;
  const styleName = style?.value ?? null;
  const styleKnowledge = getStyleKnowledge(styleName);
  const styleSummary = styleKnowledge?.summary ?? (styleName
    ? `目前只有“${styleName}”风格标签，没有可展开的本地风格通讲；不把名称或相似酒款当作本款配方与风味证据。`
    : "风格未确认；不把名称、颜色或相似酒款当作本款配方与风味证据。");

  return {
    candidateId: candidate.candidateId,
    identity: {
      menuName: candidate.displayName,
      brewery: candidate.brewery,
      canonicalName: confirmed ? entry?.canonical_name ?? null : null,
      identityStatus,
      entryId: entry?.id ?? grounding?.entryId ?? null,
    },
    style,
    abv: buildAbv(candidate, entry, confirmed),
    hops: confirmed && entry ? stringFact(entry, "hops") : null,
    ingredients: confirmed && entry ? stringFact(entry, "ingredients") : null,
    sensory,
    process: confirmed && entry ? stringFact(entry, "process") : null,
    rating: buildRating(candidate, entry, identityStatus),
    brewery: buildReputation(entry, confirmed),
    styleLayer: {
      style: styleName,
      summary: styleSummary,
      source: "style_inference",
      label: "风格通性，非本款事实",
    },
    coverage: {
      style: style ? (style.source === "social_web" ? "sourced" : "menu_observed") : "unknown",
      hops: confirmed && entry && stringFact(entry, "hops") ? "sourced" : "unknown",
      ingredients: confirmed && entry && stringFact(entry, "ingredients") ? "sourced" : "unknown",
      sensory: sensory ? "sourced" : styleKnowledge ? "style_inference" : "unknown",
      process: confirmed && entry && stringFact(entry, "process") ? "sourced" : "unknown",
      rating: buildRating(candidate, entry, identityStatus) ? "sourced" : "unknown",
    },
  };
}

export function attachBeerDossiers(
  candidates: BeerCandidate[],
  entries: MenuSupplementEntry[] = [],
): BeerCandidate[] {
  return candidates.map(candidate => ({
    ...candidate,
    dossier: buildBeerDossier(candidate, entries),
  }));
}
