import { namesMatch } from "../pipeline/match";

/**
 * Recurring service words the ASSISTANT used about each clinic it named,
 * matched to the questions they were named in. This reads our stored test
 * answers (not Google reviews). Counts only, no judgement.
 */
export const SERVICE_WORDS: Record<string, string[]> = {
  dental: [
    "emergency", "same-day", "new patients", "cleaning", "hygiene", "implants", "whitening", "invisalign", "braces", "orthodontic",
    "root canal", "crowns", "veneers", "wisdom teeth", "extraction", "dentures", "children", "kids", "family", "sedation",
    "direct billing", "insurance", "cdcp", "evening", "saturday", "weekend", "payment plan", "prices", "fees",
  ],
  family: [
    "walk-in", "family doctor", "new patients", "accepting", "virtual", "telehealth", "same-day", "physical", "forms", "sick note",
    "vaccination", "travel", "prescription", "pediatric", "children", "women's health", "lab", "blood work", "ecg", "evening",
    "weekend", "saturday", "ohip", "no appointment", "booking online", "wait time",
  ],
  medspa: [
    "laser hair removal", "botox", "neuromodulator", "filler", "microneedling", "chemical peel", "hydrafacial", "facial", "acne",
    "scar", "ipl", "skin tightening", "prp", "consultation", "nurse", "physician", "doctor", "registered", "prices", "pricing",
    "packages", "membership",
  ],
};

export interface CompetitorWords {
  name: string;
  questions: number[]; // question indices where it was recommended
  words: { word: string; count: number; questions: number[] }[];
}

/** Split an answer into chunks: lines (bullets) or sentences. */
function chunks(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((l) => l.split(/(?<=[.!?])\s+(?=[A-Z])/))
    .map((s) => s.trim())
    .filter(Boolean);
}

export function competitorServiceWords(
  sector: string,
  city: string,
  answers: { questionIndex: number; text: string; named: { name: string; status: string }[] }[],
  excludeNames: string[],
): CompetitorWords[] {
  const dict = SERVICE_WORDS[sector] ?? [];
  const byName = new Map<string, CompetitorWords>();
  for (const a of answers) {
    const parts = chunks(a.text);
    for (const n of a.named.filter((x) => x.status === "recommended")) {
      if (excludeNames.some((e) => namesMatch(e, n.name, city))) continue;
      const entry = byName.get(n.name) ?? { name: n.name, questions: [], words: [] };
      if (!entry.questions.includes(a.questionIndex)) entry.questions.push(a.questionIndex);
      // the chunk naming the clinic and the one right after it (bullet detail)
      const idx = parts.findIndex((p) => p.toLowerCase().includes(n.name.toLowerCase()));
      const scope = idx >= 0 ? (parts[idx] + " " + (parts[idx + 1] ?? "")).toLowerCase() : "";
      for (const w of dict) {
        if (!scope.includes(w)) continue;
        const ex = entry.words.find((x) => x.word === w);
        if (ex) {
          ex.count++;
          if (!ex.questions.includes(a.questionIndex)) ex.questions.push(a.questionIndex);
        } else entry.words.push({ word: w, count: 1, questions: [a.questionIndex] });
      }
      byName.set(n.name, entry);
    }
  }
  return [...byName.values()]
    .map((e) => ({ ...e, words: e.words.sort((a, b) => b.count - a.count) }))
    .sort((a, b) => b.questions.length - a.questions.length);
}
