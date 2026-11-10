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
