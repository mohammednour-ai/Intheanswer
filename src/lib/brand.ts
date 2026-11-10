/**
 * Brand, from the owner's design canvas ("In The Answer — Report Designs").
 * Mark: three lines of a list, the middle (the answer) highlighted in blue.
 */
export const BRAND = {
  ink: "#14181F",
  blue: "#1F4FD8",
  blueHover: "#163A9E",
  listGrey: "#9AA4B2",
  ground: "#F3F5F8",
  line: "#C9D1DC",
  lineSoft: "#E6EAF0",
  muted: "#4A5361",
  body2: "#2B3340",
  blueTint: "#E3EAFF",
  darkGrey: "#6B7584",
  blueOnDark: "#7FA2FF",
  amber: "#8A4B00",
  red: "#B42318",
};

/** The mark as inline SVG. `variant` "dark" is for use on ink backgrounds. */
export function markSvg(opts: { width?: number; variant?: "light" | "dark"; label?: string } = {}): string {
  const w = opts.width ?? 30;
  const h = Math.round((w * 104) / 120);
  const grey = opts.variant === "dark" ? BRAND.darkGrey : BRAND.listGrey;
  const blue = opts.variant === "dark" ? BRAND.blueOnDark : BRAND.blue;
  const a11y = opts.label ? `role="img" aria-label="${opts.label}"` : 'aria-hidden="true"';
  return `<svg width="${w}" height="${h}" viewBox="0 0 120 104" ${a11y}><rect x="8" y="8" width="84" height="20" rx="10" fill="${grey}"/><rect x="8" y="42" width="104" height="20" rx="10" fill="${blue}"/><rect x="8" y="76" width="64" height="20" rx="10" fill="${grey}"/></svg>`;
}

export const COPILOT_NAME = "In The Answer Copilot";

/**
 * Copilot avatar (design canvas: "Copilot avatar and branding"): the answer mark
 * on an ink circle; the blue presence dot marks it as the AI assistant. Always
 * presented as AI, never as a person.
 */
export function copilotAvatarSvg(opts: { size?: number; variant?: "dark" | "light"; dot?: boolean; label?: string; ring?: string } = {}): string {
  const s = opts.size ?? 32;
  const light = opts.variant === "light";
  const bg = light ? BRAND.ground : BRAND.ink;
  const grey = light ? BRAND.listGrey : BRAND.darkGrey;
  const blue = light ? BRAND.blue : BRAND.blueOnDark;
  const dot = opts.dot ?? s >= 32;
  const a11y = opts.label ? `role="img" aria-label="${opts.label}"` : 'aria-hidden="true"';
  const bars =
    s < 28
      ? `<rect x="40" y="56" width="90" height="26" rx="13" fill="${grey}"/><rect x="40" y="88" width="120" height="26" rx="13" fill="${blue}"/><rect x="40" y="120" width="66" height="26" rx="13" fill="${grey}"/>`
      : `<rect x="46" y="62" width="84" height="20" rx="10" fill="${grey}"/><rect x="46" y="92" width="108" height="20" rx="10" fill="${blue}"/><rect x="46" y="122" width="62" height="20" rx="10" fill="${grey}"/>`;
  const presence = dot
    ? `<circle cx="164" cy="40" r="20" fill="${light ? BRAND.blueOnDark : BRAND.blue}" stroke="${opts.ring ?? (light ? BRAND.ink : "#FFFFFF")}" stroke-width="8"/>`
    : "";
  return `<svg width="${s}" height="${s}" viewBox="0 0 200 200" ${a11y}><circle cx="100" cy="100" r="96" fill="${bg}"/>${bars}${presence}</svg>`;
}
