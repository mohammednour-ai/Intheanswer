import fs from "node:fs";
import path from "node:path";

/** Shared pieces for report HTML (web view and PDF are the same document). */

export function esc(s: string | number | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

let fontCss: string | null = null;
/** Space Grotesk + Inter embedded as data URIs so the PDF and the hosted page need no network. */
export function embeddedFonts(): string {
  if (fontCss) return fontCss;
  // Every path is written out in full (no computed segments) so the build's
  // file tracing can see it; next.config.ts also lists these files in
  // outputFileTracingIncludes, which is what guarantees they are deployed.
  const cwd = process.cwd();
  const faces: { family: string; weight: number; file: string }[] = [
    { family: "Inter", weight: 400, file: path.join(cwd, "node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2") },
    { family: "Inter", weight: 600, file: path.join(cwd, "node_modules/@fontsource/inter/files/inter-latin-600-normal.woff2") },
    { family: "Inter", weight: 700, file: path.join(cwd, "node_modules/@fontsource/inter/files/inter-latin-700-normal.woff2") },
    { family: "Space Grotesk", weight: 500, file: path.join(cwd, "node_modules/@fontsource/space-grotesk/files/space-grotesk-latin-500-normal.woff2") },
    { family: "Space Grotesk", weight: 600, file: path.join(cwd, "node_modules/@fontsource/space-grotesk/files/space-grotesk-latin-600-normal.woff2") },
    { family: "Space Grotesk", weight: 700, file: path.join(cwd, "node_modules/@fontsource/space-grotesk/files/space-grotesk-latin-700-normal.woff2") },
  ];
  let missing = 0;
  const css = faces
    .map((f) => {
      try {
        const b64 = fs.readFileSync(/* turbopackIgnore: true */ f.file).toString("base64");
        return `@font-face{font-family:"${f.family}";font-weight:${f.weight};font-style:normal;font-display:swap;src:url(data:font/woff2;base64,${b64}) format("woff2");}`;
      } catch (e) {
        // The report still renders (system fonts), but say so: a missing font is a deployment fault.
        missing++;
        console.error(`report font missing: ${f.family} ${f.weight} (${f.file}): ${(e as Error).message}`);
        return "";
      }
    })
    .join("");
  // keep the result only when complete, so a later call can pick the fonts up once they are there
  if (!missing) fontCss = css;
  return css;
}

export const REPORT_CSS = `
:root{--ink:#14181F;--blue:#1F4FD8;--grey:#9AA4B2;--ground:#F3F5F8;--line:#C9D1DC;--line2:#E6EAF0;--muted:#4A5361;--body2:#2B3340;--tint:#E3EAFF;--amber:#8A4B00;--red:#B42318}
*{box-sizing:border-box}
html,body{margin:0;background:#fff;color:var(--ink)}
body{font:13px/1.45 Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
h1,h2,h3{font-family:"Space Grotesk",Inter,sans-serif;margin:0}
a{color:var(--blue)}a:hover{color:#163A9E}
.page{max-width:816px;margin:0 auto;padding:44px 48px;display:flex;flex-direction:column;gap:22px}
.top{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;border-bottom:2px solid var(--ink);padding-bottom:12px}
.brand{display:flex;align-items:center;gap:10px}
.wordmark{font-family:"Space Grotesk",Inter,sans-serif;font-weight:700;font-size:20px;letter-spacing:-.2px}
.doc{font-size:12px;color:var(--muted);text-align:right}
.label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;font-weight:600}
.who{display:flex;flex-direction:column;gap:6px}
h1{font-size:28px;line-height:1.15;font-weight:700}
.meta{color:var(--muted)}
.badge-sample{align-self:flex-start;background:var(--ink);color:#fff;font-weight:700;font-size:11.5px;padding:3px 10px;border-radius:6px;letter-spacing:.04em}
.hero{display:flex;gap:20px;align-items:stretch}
.score{flex:0 0 250px;background:var(--ink);color:#fff;border-radius:10px;padding:20px 22px;display:flex;flex-direction:column;gap:6px}
.score .label{color:#C9D1DC}
.score .num{font-family:"Space Grotesk",Inter,sans-serif;font-size:60px;line-height:1;font-weight:700}
.score .num span{font-size:26px;font-weight:500;color:#C9D1DC}
.score .cap{font-size:12.5px;color:#E6EAF0}
.summary{flex:1;background:var(--ground);border-radius:10px;padding:18px 20px;display:flex;flex-direction:column;gap:8px;justify-content:center}
.summary .head{font-weight:600;font-size:14px}
.summary p{margin:0;color:var(--body2)}
section{display:flex;flex-direction:column;gap:8px}
h2{font-size:16px;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{text-align:left;color:var(--muted);font-weight:600;padding:7px 8px;border-bottom:1px solid var(--line)}
td{padding:8px;border-bottom:1px solid var(--line2);vertical-align:top}
th:first-child,td:first-child{padding-left:0}th:last-child,td:last-child{padding-right:0}
.st{white-space:nowrap}
.st-recommended{font-weight:700;color:var(--blue)}
.st-listed_only{font-weight:600;color:var(--amber)}
.st-not_named{font-weight:700;color:var(--red)}
.none{color:var(--muted)}
.key{font-size:11.5px;color:var(--muted)}
.findings{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px}
.finding{background:var(--ground);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:6px;break-inside:avoid}
.finding .n{font-family:"Space Grotesk",Inter,sans-serif;font-size:22px;font-weight:700;color:var(--blue);line-height:1}
.finding .t{font-weight:600}
.finding p{margin:0;color:var(--body2);font-size:12.5px}
.finding .src{font-size:11px;color:var(--muted);word-break:break-all}
.offers{display:grid;grid-template-columns:5fr 7fr;gap:14px;align-items:stretch}
.offers.three{grid-template-columns:1fr 1fr}.offers.three .offer.main{grid-column:1 / -1}
.price span.dim{color:var(--muted)}
.offer{border:1.5px solid var(--line);border-radius:10px;padding:16px 18px;display:flex;flex-direction:column;gap:8px;break-inside:avoid}
.price{font-family:"Space Grotesk",Inter,sans-serif;font-weight:700;font-size:22px}
.price span{font-size:14px;font-weight:500;color:var(--tint)}
.offer p{margin:0;color:var(--body2);font-size:12.5px}
.btn{align-self:flex-start;text-decoration:none;font-weight:600;font-size:13px;padding:12px 16px;border-radius:8px;border:1.5px solid var(--ink);color:var(--ink)}
.offer .btn{margin-top:auto}
.offer.main{background:var(--blue);border-color:var(--blue);color:#fff}
.offer.main .label{color:var(--tint)}
.offer.main .pill{background:#fff;color:var(--ink);font-size:11.5px;font-weight:600;padding:3px 10px;border-radius:999px}
.offer.main ul{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:3px;font-size:12.5px}
.offer.main .btn{background:#fff;border-color:#fff;color:var(--ink);margin-top:4px}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px}
.byline{display:flex;align-items:center;gap:10px;background:var(--ground);border-radius:8px;padding:10px 12px;font-size:12px;color:var(--body2);margin-bottom:6px}.byline strong{color:var(--ink)}
.foot{border-top:1px solid var(--line);padding-top:10px;display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--muted)}
pre.file{margin:0;white-space:pre-wrap;word-break:break-word;background:var(--ink);color:#E6EAF0;border-radius:10px;padding:14px 18px;font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
@media (max-width:700px){.page{padding:24px 16px}.hero{flex-direction:column}.score{flex-basis:auto}.findings,.offers{grid-template-columns:1fr}.top{flex-direction:column;align-items:flex-start}.doc{text-align:left}h1{font-size:23px}.table-wrap{overflow-x:auto}}
@media print{@page{size:Letter;margin:12mm}.page{padding:0;max-width:none}a{color:inherit}.offer.main .btn{color:var(--ink)}}
`;

export function documentShell(title: string, body: string, opts: { noindex?: boolean } = {}): string {
  return `<!doctype html><html lang="en-CA"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>${opts.noindex !== false ? '<meta name="robots" content="noindex,nofollow">' : ""}
<style>${embeddedFonts()}${REPORT_CSS}</style></head><body>${body}</body></html>`;
}
