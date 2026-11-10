export type CheckResult = "found" | "not_found" | "could_not_verify";

export interface Evidence {
  kind: "page_quote" | "pages_read" | "raw_source" | "robots" | "answer_quote" | "directory_quote" | "contact";
  url?: string;
  quote?: string;
  label?: string;
}

export interface CheckOutcome {
  key: string;
  result: CheckResult;
  /** One plain sentence of what was observed. Never claims more than the evidence. */
  summary: string;
  evidence: Evidence[];
  /** True when this result is a concrete gap the clinic can fix. */
  isGap: boolean;
  /** Higher = more concrete and useful in a teaser. */
  severity: number;
  /** Sentence for a report finding card (only for gaps). */
  findingText?: string;
}

/** Display names, used in reports. */
export const CHECK_LABELS: Record<string, string> = {
  questions_answered: "Patient questions answered on the site",
  new_patients: "New-patient status",
  hours: "Opening hours",
  hours_conflict: "Hours that disagree",
  fees: "Fees for uninsured services",
  insurance_billing: "Insurance and direct billing",
  practitioners: "Practitioner names and credentials",
  languages: "Languages spoken",
  areas_served: "Areas served",
  address_on_home: "Address on the home page",
  meta_description: "Page description",
  outdated_notices: "Outdated notices",
  structured_data: "Structured data in the page source",
  directory_consistency: "Name and details across directories",
  contact_email_own_domain: "Contact email on your own domain",
  ai_crawlers: "AI crawlers allowed by robots.txt",
};
