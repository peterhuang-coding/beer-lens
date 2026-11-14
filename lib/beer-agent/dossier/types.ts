export type DossierSource =
  | "ocr"
  | "manual_user_input"
  | "venue_site"
  | "social_web"
  | "untappd"
  | "legacy_db"
  | "style_inference"
  | "user_profile";

/** A field-level assertion. A missing claim is null, never an inferred fact. */
export type Claim<T> = {
  value: T;
  source: DossierSource;
  sourceKind?: string;
  url?: string;
  access?: string;
  excerpt?: string;
  checkedAt?: string;
  publishedAt?: string;
  reviewStatus: "curated" | "unreviewed";
  usable: boolean;
};

export type IdentityStatus =
  | "unmatched"
  | "confirmed"
  | "version_unresolved"
  | "batch_unresolved";

export type Reputation = {
  kind: "classic" | "flagship" | "award" | "community";
  text: string;
};

export type BeerDossier = {
  candidateId: string;
  identity: {
    menuName: string;
    brewery: string;
    canonicalName: string | null;
    identityStatus: IdentityStatus;
    entryId: string | null;
  };
  style: Claim<string> | null;
  abv: {
    observations: Claim<number>[];
    conflicted: boolean;
    resolution: string | null;
  };
  hops: Claim<string[]> | null;
  ingredients: Claim<string[]> | null;
  sensory: Claim<string[]> | null;
  process: Claim<string[]> | null;
  rating: Claim<{ score: number; count: number }> | null;
  brewery: {
    flagship: {
      status: "unproven" | "sourced";
      beer: string | null;
      claim: Claim<Reputation> | null;
    };
    reputation: Claim<Reputation>[];
  };
  styleLayer: {
    style: string | null;
    summary: string;
    source: "style_inference";
    label: "风格通性，非本款事实";
  };
  coverage: {
    style: "menu_observed" | "sourced" | "unknown";
    hops: "sourced" | "unknown";
    ingredients: "sourced" | "unknown";
    sensory: "sourced" | "style_inference" | "unknown";
    process: "sourced" | "unknown";
    rating: "sourced" | "unknown";
  };
};
