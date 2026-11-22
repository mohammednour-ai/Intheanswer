/**
 * Phone numbers. The agent only dials Canadian numbers: the clinics are in
 * Ontario, and an allow-list keeps a public form from being used to make us
 * dial premium, toll-free or overseas numbers.
 */

/** Canadian geographic area codes. Add new ones here as they come into service. */
export const CANADIAN_AREA_CODES = new Set([
  // Ontario
  "226", "249", "289", "343", "365", "382", "416", "437", "519", "548", "613", "647", "683", "705", "742", "753", "807", "905", "942",
  // Quebec
  "263", "354", "367", "418", "438", "450", "468", "514", "579", "581", "819", "873",
  // British Columbia
  "236", "250", "257", "604", "672", "778",
  // Alberta
  "368", "403", "587", "780", "825",
  // Saskatchewan and Manitoba
  "306", "474", "639", "204", "431", "584",
  // Atlantic provinces
  "428", "506", "709", "879", "782", "902",
  // Territories
  "867",
]);

/** Ten digits of a North American number, or null. "+1 (705) 555-0100" and "(705) 555-0100" pass; "705.555.0100 ext 4" does not. */
function tenDigits(raw: string): string | null {
  const s = raw.trim();
  if (!/^[+(\d][\d\s().-]{6,24}$/.test(s)) return null;
  let d = s.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length !== 10) return null;
  // area code and exchange never start with 0 or 1
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(d)) return null;
  return d;
}

/** E.164 for a Canadian number a person typed, or null when it is not one we call. */
export function normalizeCanadianPhone(raw: string): string | null {
  const d = tenDigits(raw);
  if (!d || !CANADIAN_AREA_CODES.has(d.slice(0, 3))) return null;
  return `+1${d}`;
}

/** The last ten digits of anything phone-like, for matching a stored display number to a caller ID. */
export function lastTen(raw: string | null | undefined): string | null {
  const d = (raw ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
}

/** "+17055550100" -> "705-555-0100" (for pages and the portal). */
export function displayPhone(e164: string): string {
  const d = lastTen(e164);
  return d ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : e164;
}

/** A number the way a voice should read it: digit by digit, in groups. */
export function speakablePhone(raw: string): string {
  const d = lastTen(raw);
  if (!d) return raw;
  const spell = (x: string) => x.split("").join(" ");
  return `${spell(d.slice(0, 3))}, ${spell(d.slice(3, 6))}, ${spell(d.slice(6))}`;
}

const NUMBER_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
};
/** Words speech recognition writes for a digit that are also ordinary words. */
const SOUND_ALIKES: Record<string, string> = { oh: "0", o: "0", to: "2", too: "2", for: "4", ate: "8" };

/**
 * A six-digit report code out of what the caller keyed or said ("482913",
 * "my code is four eight two, nine one three", "4 8 2 9 oh 3"). Null unless
 * exactly six digits come out. A sound-alike ("oh", "to", "for") counts as a
 * digit only when the caller said nothing but digits, so an ordinary sentence
 * is never mistaken for a code.
 */
export function spokenCode(input: string | null | undefined): string | null {
  if (!input) return null;
  const tokens = input.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  const strict = tokens.map((t) => (/^\d+$/.test(t) ? t : NUMBER_WORDS[t] ?? "")).join("");
  if (strict.length === 6) return strict;
  const all = tokens.map((t) => (/^\d+$/.test(t) ? t : NUMBER_WORDS[t] ?? SOUND_ALIKES[t] ?? null));
  if (all.every((x) => x !== null) && all.join("").length === 6) return all.join("");
  return null;
}
