/**
 * Review text analysis depends on volume:
 *   30 or more reviews: full analysis
 *   10 to 29: light analysis, labelled "small sample"
 *   under 10: no text analysis; the low count is the finding
 */
export type AnalysisLevel = "full" | "light" | "none";

export const FULL_MIN = 30;
export const LIGHT_MIN = 10;

export function analysisLevel(totalReviews: number): AnalysisLevel {
  if (totalReviews >= FULL_MIN) return "full";
  if (totalReviews >= LIGHT_MIN) return "light";
  return "none";
}

export function levelLabel(level: AnalysisLevel): string {
  return level === "full" ? "full analysis" : level === "light" ? "small sample" : "too few reviews to analyse";
}

/** Low review volume (drives the review-request kit). */
export function isLowVolume(totalReviews: number): boolean {
  return totalReviews < FULL_MIN;
}
