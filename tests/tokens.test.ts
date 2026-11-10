import { describe, expect, it } from "vitest";
import { unsubscribeToken, verifyUnsubscribeToken, randomToken } from "@/lib/tokens";

describe("tokens", () => {
  it("unsubscribe tokens round-trip and reject tampering", () => {
    const t = unsubscribeToken("Info@Clinic.example ");
    expect(verifyUnsubscribeToken(t)).toBe("info@clinic.example");
    const [b] = t.split(".");
    const forged = `${Buffer.from("other@clinic.example").toString("base64url")}.${t.split(".")[1]}`;
    expect(verifyUnsubscribeToken(forged)).toBeNull();
    expect(verifyUnsubscribeToken(b)).toBeNull();
    expect(verifyUnsubscribeToken("garbage")).toBeNull();
  });
  it("report tokens are long and unique", () => {
    const a = randomToken();
    expect(a.length).toBeGreaterThanOrEqual(22);
    expect(a).not.toBe(randomToken());
  });
});
