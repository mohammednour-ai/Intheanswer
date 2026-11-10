import { describe, expect, it } from "vitest";
import { siteTestChanges, pageResultTrend, renderMonthlyServices } from "@/lib/reports/monthly";

describe("monthly report: services", () => {
  it("lists only site checks whose result changed", () => {
    const c = siteTestChanges(
      [{ check_key: "booking_path", result: "needs_work" }, { check_key: "https", result: "pass" }],
      [{ check_key: "booking_path", result: "pass", line: "ok" }, { check_key: "https", result: "pass", line: "ok" }, { check_key: "alt_text", result: "needs_work", line: "3 images" }],
    );
    expect(c.map((x) => `${x.key}:${x.before}>${x.after}`)).toEqual(["booking_path:needs_work>pass", "alt_text:null>needs_work"]);
  });
  it("says whether a live page's target question improved", () => {
    expect(pageResultTrend("not_named", "listed_only")).toBe("improved");
    expect(pageResultTrend("recommended", "not_named")).toBe("lower");
    expect(pageResultTrend("listed_only", "listed_only")).toBe("unchanged");
    expect(pageResultTrend("not_named", null)).toBe("not tested yet");
  });
  it("renders review changes only when a profile is connected", () => {
    const html = renderMonthlyServices({ reviews: null, siteChanges: [], pages: [] });
    expect(html).not.toMatch(/Reviews this month/);
    expect(html).toMatch(/No site test results changed/);
  });
});
