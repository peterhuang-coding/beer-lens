export type CandidateInput = {
  displayName: string;
  brewery?: string;
  style?: string;
  abv?: number;
  price?: number | null;
  volumeMl?: number | null;
  confidence?: number;
};

export type ScoredCandidate = {
  candidateId: string;
  menuIndex: number;
  displayName: string;
  brewery: string;
  style: string;
  abv: number;
  price: number | null;
  volumeMl: number | null;
  worthScore: number;
  fitScore: number;
  riskFlags: string[];
  reason: string;
  // enriched data
  rating?: number | null;
  ratingsCount?: number | null;
  source?: string;
};

export type PickResult = {
  topPick: {
    candidateId: string;
    label: string;
    reason: string;
    worthScore: number;
    fitScore: number;
  };
  safePick: {
    candidateId: string;
    label: string;
    reason: string;
    worthScore: number;
    fitScore: number;
  };
  explorePick: {
    candidateId: string;
    label: string;
    reason: string;
    worthScore: number;
    fitScore: number;
  };
  avoidOrCaution: {
    candidateId: string;
    label: string;
    reason: string;
    worthScore: number;
    fitScore: number;
  };
};
