// VQA Pipeline types — shared across scripts, API routes, and debug UI.

export interface VqaQuestion {
  id: string;
  type: "yesno" | "text" | "select";
  prompt: string;
  options?: string[];
}

export interface VqaLabels {
  beerName?: string;
  brand?: string;
  style?: string;
  abv?: string;
  visibleText?: string;
  isBeerLabel?: boolean;
  imageQuality?: "good" | "ok" | "bad" | "unusable";
  confidence?: "high" | "medium" | "low";
  notes?: string;
}

export type VqaStatus = "pending" | "labeled" | "skipped" | "exported";

export interface VqaTask {
  id: string;
  source: string;
  sourceUrl: string;
  imageUrl: string;
  localImagePath?: string;
  title?: string;
  candidateBeerName?: string;
  brand?: string;
  style?: string;
  abv?: string;
  description?: string;
  questions: VqaQuestion[];
  labels: VqaLabels;
  status: VqaStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CrawlItem {
  sourceName: string;
  sourceUrl: string;
  imageUrl: string;
  pageTitle?: string;
  pageDescription?: string;
  candidateBeerName?: string;
  crawledAt: string;
}

export interface SeedSource {
  name: string;
  url: string;
  description?: string;
}

/** Recorded crawl error — not a badcase, just an infrastructure failure */
export interface CrawlError {
  sourceName: string;
  sourceUrl: string;
  errorMessage: string;
  errorType: "http_error" | "timeout" | "parse_error" | "dns_error" | "unknown";
  timestamp: string;
}

/** Crawl error log file format */
export interface CrawlErrorLog {
  version: 1;
  errors: CrawlError[];
}

/** Image URL check result */
export interface ImageUrlCheck {
  url: string;
  accessible: boolean;
  contentType?: string;
  statusCode?: number;
  error?: string;
}
