import { describe, expect, it } from "vitest";
import { analysisLevel, levelLabel, isLowVolume } from "@/lib/reviews/thresholds";
import { computeMetrics, scrubThemes, diffSnapshots, type GbpReview } from "@/lib/reviews/gbp";
import { competitorServiceWords } from "@/lib/reviews/serviceWords";
import { kitMessage, reviewKitHtml, KIT_RULES } from "@/lib/reviews/kit";
import { writeReviewUrl } from "@/lib/reviews/placesLive";
import { seal, open } from "@/lib/crypto";

describe("review volume thresholds", () => {
  it("30+ full, 10-29 light (small sample), under 10 none", () => {
    expect([0, 9, 10, 29, 30, 500].map(analysisLevel)).toEqual(["none", "none", "light", "light", "full", "full"]);
    expect(levelLabel("light")).toBe("small sample");
    expect(isLowVolume(29)).toBe(true);
    expect(isLowVolume(30)).toBe(false);
  });
});

describe("Business Profile metrics (own reviews only)", () => {
  const now = new Date("2026-11-11T12:00:00Z");
  const r = (days: number, reply: boolean, star: GbpReview["starRating"] = "FIVE"): GbpReview => ({
    starRating: star, createTime: new Date(now.getTime() - days * 86400e3).toISOString(), comment: "ok", ...(reply ? { reviewReply: { comment: "thanks", updateTime: "" } } : {}),
  });
  it("computes latest, last-90-days count and reply rate", () => {
    const m = computeMetrics([r(5, true), r(40, false), r(100, true), r(400, false)], 4, 4.5, now);
    expect(m.count90d).toBe(2);
    expect(m.replyRate).toBe(0.5);
    expect(m.latest).toBe(r(5, true).createTime);
    expect(m.level).toBe("none");
    expect(m.average).toBe(4.5);
  });
  it("uses the API total when it is larger than the reviews fetched", () => {
    expect(computeMetrics([r(1, false)], 120, 4.1, now)).toMatchObject({ total: 120, level: "full" });
  });
  it("drops theme labels that carry a person or a health detail", () => {
    const t = scrubThemes({
      praise: [{ theme: "friendly front desk", mentions: 9 }, { theme: "Dr. Smith was kind", mentions: 3 }],
      complaint: [{ theme: "billing questions", mentions: 2 }, { theme: "my cancer diagnosis", mentions: 1 }],
      service: [{ theme: "cleanings", mentions: 5 }, { theme: "anxiety about surgery", mentions: 1 }],
    });
    expect(t.praise.map((x) => x.theme)).toEqual(["friendly front desk"]);
    expect(t.complaint.map((x) => x.theme)).toEqual(["billing questions"]);
    expect(t.service.map((x) => x.theme)).toEqual(["cleanings"]);
  });
  it("compares against last month", () => {
    expect(diffSnapshots({ total_count: 40, average_rating: 4.5, count_90d: 3, reply_rate: 0.2 }, { total_count: 46, average_rating: 4.6, count_90d: 7, reply_rate: 0.5 }))
      .toEqual({ totalChange: 6, averageChange: 0.1, count90dChange: 4, replyRateChange: 0.3 });
    expect(diffSnapshots(null, { total_count: 1, average_rating: 5, count_90d: 1, reply_rate: 0 }).totalChange).toBeNull();
  });
  it("seals refresh tokens at rest", () => {
    const s = seal("refresh-token-value");
    expect(s).not.toContain("refresh-token-value");
    expect(open(s)).toBe("refresh-token-value");
  });
});

describe("competitor service words (from our stored answers, counts only)", () => {
  it("matches words to the questions each clinic was named in, excluding the target", () => {
    const out = competitorServiceWords("dental", "Barrie", [
      { questionIndex: 1, text: "1. Lakeshore Dental offers emergency and same-day visits.\n2. Maple Dental: implants and whitening.", named: [{ name: "Lakeshore Dental", status: "recommended" }, { name: "Maple Dental", status: "recommended" }] },
      { questionIndex: 4, text: "Lakeshore Dental does direct billing.", named: [{ name: "Lakeshore Dental", status: "recommended" }] },
    ], ["Maple Dental"]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Lakeshore Dental");
    expect(out[0].questions).toEqual([1, 4]);
    expect(out[0].words.map((w) => w.word)).toEqual(expect.arrayContaining(["emergency", "same-day", "direct billing"]));
  });
});

describe("review-request kit", () => {
  it("says ask every patient, no incentive, no filtering, and links to the review form", async () => {
    const k = await reviewKitHtml("Maple Grove Dental", "ChIJabc123");
    expect(KIT_RULES.join(" ")).toMatch(/every patient/);
    expect(KIT_RULES.join(" ")).toMatch(/Offer nothing in return/);
    expect(KIT_RULES.join(" ")).toMatch(/Do not filter/);
    expect(k.html).toContain("<svg");
    expect(k.link).toBe(writeReviewUrl("ChIJabc123"));
    expect(kitMessage("X", k.link)).not.toMatch(/discount|gift|draw|best/i);
  });
});
