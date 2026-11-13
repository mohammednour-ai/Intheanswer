import type { Evidence } from "../pipeline/audit/types";

export type RowStatus = "recommended" | "listed_only" | "not_named";

export interface ReportRow {
  questionIndex: number;
  question: string;
  status: RowStatus;
  matchedAs: string | null;
  /** Clinics the answer recommended (other than this clinic), as written in the answer. */
  namedInstead: string[];
  answerId: string;
}

export interface ReportFinding {
  /** audit check key, or "site:<key>" for a site test check */
  checkKey: string;
  source?: "audit" | "site";
  title: string;
  text: string;
  evidence: Evidence[];
  fix?: string;
}

/** A claim made anywhere in a report or email, with what supports it. */
export interface Claim {
  id: string;
  where: "summary" | "row" | "finding" | "email";
  claim: string;
  evidence: (Evidence & { ref?: string })[];
  verified?: boolean;
}

export interface OwnerFooter {
  name: string;
  businessName: string;
  mailingAddress: string;
  phone: string;
  email: string;
}

export interface TeaserData {
  kind: "teaser" | "sample";
  clinic: { id: string | null; name: string; city: string; website: string; domain: string };
  sector: { name: string; patientNoun: string; regulatorNote: string };
  test: { assistant: string; model: string; servedModels: string[]; date: string; dateIso: string; questionCount: number };
  score: { recommended: number; listedOnly: number; total: number };
  summary: [string, string];
  rows: ReportRow[];
  findings: ReportFinding[];
  pagesRead: number;
  /** Confirmed gaps in the audit and site test (the full report covers all of them). */
  findingsTotal: number;
  /** Site test run the site findings come from (for the verification gate). */
  siteRunId?: string | null;
  /** reportsUrl and reportsMinTerm are missing on teasers stored before the monthly reports plan existed. */
  offers: { oneTimeUrl: string; monthlyUrl: string; minTerm: string; reportsUrl?: string; reportsMinTerm?: string };
  limits: string;
  owner: OwnerFooter;
  claims: Claim[];
}
