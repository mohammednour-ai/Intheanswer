import { describe, expect, it } from "vitest";
import { matchClinic, namesMatch, distinctiveTokens } from "@/lib/pipeline/match";
import { qualifies } from "@/lib/pipeline/score";
import { extractAnswer } from "@/lib/adapters/claude";

describe("matching clinics to answers", () => {
  it("uses distinctive tokens, not category words or the city", () => {
    expect(distinctiveTokens("Barrie Family Dental Centre", "Barrie")).toEqual([]);
    expect(distinctiveTokens("Adental Office", "Barrie")).toEqual(["adental"]);
    expect(namesMatch("Adental Office", "Adental Office Barrie", "Barrie")).toBe(true);
    expect(namesMatch("Adental Office", "A Dental Care", "Barrie")).toBe(false);
    expect(namesMatch("Barrie Family Dental Centre", "Barrie Dental Centre", "Barrie")).toBe(false);
  });
  const c = { clinicName: "Maple Grove Dental", domain: "maplegrove.example", city: "Barrie" };
  it("recommended beats listed", () => {
    const r = matchClinic(c, {
      text: "",
      named: [
        { name: "Maple Grove Dental", url: null, status: "listed_only", quote: "q1" },
        { name: "Maple Grove Dental Clinic", url: null, status: "recommended", quote: "q2" },
      ],
      citedUrls: [],
    });
    expect(r).toMatchObject({ status: "recommended", evidence: "q2" });
  });
  it("matches by own domain, and a cited own page counts as listed only", () => {
    expect(matchClinic(c, { text: "", named: [{ name: "MGD", url: "https://www.maplegrove.example/x", status: "recommended", quote: "q" }], citedUrls: [] }).status).toBe("recommended");
    expect(matchClinic(c, { text: "", named: [], citedUrls: ["https://maplegrove.example/fees"] }).status).toBe("listed_only");
    expect(matchClinic(c, { text: "", named: [], citedUrls: ["https://yelp.ca/x"] }).status).toBe("not_named");
  });
});

describe("selection", () => {
  it("needs at least two questions not recommended and three confirmed findings", () => {
    expect(qualifies(6, 5, 5).ok).toBe(false);
    expect(qualifies(6, 4, 3).ok).toBe(true);
    expect(qualifies(6, 0, 2).ok).toBe(false);
  });
});

describe("answer extraction", () => {
  it("collects text, sources and which sources were cited", () => {
    const r = extractAnswer([
      { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://a.example", title: "A" }, { type: "web_search_result", url: "https://b.example", title: "B" }] },
      { type: "text", text: "Try Maple Grove Dental.", citations: [{ type: "web_search_result_location", url: "https://a.example", title: "A", cited_text: "Maple Grove" }] },
      { type: "text", text: " Or call around.", citations: null },
    ]);
    expect(r.text).toBe("Try Maple Grove Dental. Or call around.");
    expect(r.sources).toEqual([
      { url: "https://a.example", title: "A", cited: true },
      { url: "https://b.example", title: "B", cited: false },
    ]);
  });
});
