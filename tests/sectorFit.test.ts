import { describe, expect, it } from "vitest";
import { sectorFit } from "@/lib/pipeline/sectorFit";

const pad = (s: string) => s + " " + "Book a visit with our friendly team in Barrie. ".repeat(12);

describe("sector check", () => {
  it("a real medspa fits", () => {
    const f = sectorFit("medspa", [pad("Botox, dermal fillers, laser hair removal and microneedling at our medical spa.")]);
    expect(f.ok).toBe(true);
    expect(f.own).toBeGreaterThanOrEqual(4);
  });

  it("a therapy clinic in the medspa sector does not (the Evergreen case)", () => {
    const f = sectorFit("medspa", [pad("Naturopathic medicine, chiropractic, acupuncture and registered massage therapy. Physiotherapy for injuries.")]);
    expect(f.ok).toBe(false);
    expect(f.reason).toMatch(/^not a medspa: its site is mainly about other care/);
  });

  it("a day spa with no medspa services does not", () => {
    const f = sectorFit("medspa", [pad("Our day spa offers pedicures, manicures and hot stone massage.")]);
    expect(f.ok).toBe(false);
  });

  it("a medspa that also does manicures still fits: the other kind must clearly dominate", () => {
    const f = sectorFit("medspa", [pad("Botox, fillers, IPL and laser hair removal. Manicures and pedicures too.")]);
    expect(f.ok).toBe(true);
  });

  it("a site that names the services fewer than three times does not", () => {
    const f = sectorFit("medspa", [pad("We offer Botox.")]);
    expect(f.ok).toBe(false);
    expect(f.reason).toMatch(/only 1 time/);
  });

  it("too little readable text decides nothing", () => {
    const f = sectorFit("medspa", ["Physiotherapy"]);
    expect(f).toMatchObject({ ok: true, unknown: true });
  });

  it("a walk-in clinic that also runs a medspa still fits the family sector", () => {
    const f = sectorFit("family", [pad("Walk-in clinic with family physicians and doctors. Our medspa offers Botox.")]);
    expect(f.ok).toBe(true);
  });

  it("dental and an unknown sector", () => {
    expect(sectorFit("dental", [pad("Our dentists offer cleanings, implants, crowns and Invisalign.")]).ok).toBe(true);
    expect(sectorFit("vet", [pad("anything")])).toMatchObject({ ok: true, unknown: true });
  });
});
