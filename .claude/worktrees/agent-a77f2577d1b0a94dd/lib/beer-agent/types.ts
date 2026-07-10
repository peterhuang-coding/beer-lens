export type AgentMode = "recommend" | "benchmark";

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type AgentRequest = {
  mode?: AgentMode;
  messages: ChatMessage[];
  image?: {
    name: string;
    type: string;
    dataUrl?: string;
  };
};

export type Evidence = {
  source:
    | "user_profile"
    | "ocr"
    | "untappd"
    | "venue_site"
    | "google_places"
    | "social_web"
    | "manual_user_input"
    | "agent_inference";
  summary: string;
  confidence: number;
};

export type BeerCandidate = {
  candidateId: string;
  menuIndex: number;
  displayName: string;
  brewery: string;
  style: string;
  abv: number;
  ibu?: number | null;
  hops: string[];
  worthScore: number;
  fitScore: number;
  riskFlags: string[];
  reason: string;
  evidence: Evidence[];
  // enriched from Untappd
  untappdId?: string | null;
  untappdScore?: number | null;
  untappdRatingCount?: number | null;
  untappdUrl?: string | null;
  breweryCountry?: string | null;
  labelImage?: string | null;
  // pricing
  price?: number | null;
  volumeMl?: number | null;
  pricePerMl?: number | null;
  valueScore?: number | null;
  originBenchmark?: number | null;    // estimated ORIGIN country price (RMB)
  savingsVsOrigin?: number | null;    // % cheaper than origin country (>0 = cheaper here)
  // Structured recommendation reasons for debug/review UI.
  objectiveReasons?: string[];
  personalReasons?: string[];
  riskReasons?: string[];
};

export type Pick = {
  candidateId: string;
  label: string;
  reason: string;
  worthScore: number;
  fitScore: number;
};

/** Structured diagnosis of the recommendation pipeline. */
export type RecommendationDiagnosis = {
  ocrCandidateCount: number;
  dbLookupCount: number;
  dbHitCount: number;
  dataMissingCount: number;
  scoringInputs: Array<{
    candidateId: string;
    displayName: string;
    rating: number | null;
    ratingsCount: number | null;
    worthScore: number;
    fitScore: number;
    scoringWeights: {
      base: number;
      ratingBonus: number;
      priceBonus: number;
      abvPenalty: number;
      missingDataPenalty: number;
      profileFitBonus: number;
      constraintBonus: number;
    };
  }>;
  topPickReason: string;
  riskFlags: string[];
  memoryUsed: boolean;
  constraintsUsed: string[];
  pipelineStages?: {
    imageContext?: unknown;
    extractedCount?: number;
    visualQuality?: unknown;
    enrichmentLog?: unknown[];
  };
};

export type AgentResponse = {
  mode: AgentMode;
  reply: string;
  candidates: BeerCandidate[];
  picks: {
    topPick: Pick;
    safePick: Pick;
    explorePick: Pick;
    avoidOrCaution: Pick;
  };
  benchmarkPrompt?: BenchmarkQuestion[];
  profileSummary: string;
  /** Multi-stage pipeline intermediate results for UI visualization */
  stages?: Record<string, unknown>;
  /** Route diagnosis — injected by dispatcher after routing. */
  routeDiagnosis?: import("./route-registry").RouteDiagnosis;
  /** Recommendation pipeline diagnosis for debugging badcases. */
  diagnosis?: RecommendationDiagnosis;
};

export type BenchmarkQuestion = {
  id: string;
  prompt: string;
  type: "single" | "multi" | "text";
  options?: {
    value: string;
    label: string;
  }[];
};

export type JournalEntry = {
  id: string;
  createdAt: string;
  rawInput: string;
  parsed: {
    beerName?: string;
    overallScore?: number;
    wouldDrinkAgain?: "no" | "maybe" | "yes";
    aromaTags: string[];
    tasteTags: string[];
    contextTags: string[];
    note?: string;
  };
};
