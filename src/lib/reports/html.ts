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
  const root = path.join(process.cwd(), "node_modules", "@fontsource");
  const face = (family: string, dir: string, file: string, weight: number) => {
    try {
      const b64 = fs.readFileSync(path.join(root, dir, "files", file)).toString("base64");
      return `@font-face{font-family:"${family}";font-weight:${weight};font-style:normal;font-display:swap;src:url(data:font/woff2;base64,${b64}) format("woff2");}`;
    } catch {
      return "";
    }
  };
  fontCss = [
    face("Inter", "inter", "inter-latin-400-normal.woff2", 400),
    face("Inter", "inter", "inter-latin-600-normal.woff2", 600),
    face("Inter", "inter", "inter-latin-700-normal.woff2", 700),
    face("Space Grotesk", "space-grotesk", "space-grotesk-latin-500-normal.woff2", 500),
    face("Space Grotesk", "space-grotesk", "space-grotesk-latin-700-normal.woff2", 700),
  ].join("");
  return fontCss;
}

export const REPORT_CSS = `
:root{--ink:#111418;--ink2:#3f4651;--muted:#5b6370;--line:#e3e6ea;--soft:#f5f6f8;--blue:#1d4ed8;--blue-soft:#eef3ff}
*{box-sizing:border-box}
html,body{margin:0;background:#fff;color:var(--ink)}
body{font:15px/1.55 Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
h1,h2,h3{font-family:"Space Grotesk",Inter,sans-serif;letter-spacing:-.01em;line-height:1.2;margin:0}
a{color:var(--blue)}
.page{max-width:860px;margin:0 auto;padding:32px 20px 40px}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:2px solid var(--ink);padding-bottom:16px}
.wordmark{font-family:"Space Grotesk",sans-serif;font-weight:700;font-size:18px;display:flex;align-items:center;gap:8px;white-space:nowrap}
.wordmark i{display:inline-block;width:12px;height:12px;background:var(--blue)}
.meta{text-align:right;font-size:13px;color:var(--ink2)}
.meta strong{color:var(--ink)}
h1.clinic{font-size:30px;margin:24px 0 4px}
.sub{color:var(--ink2);margin:0 0 20px}
.hero{display:grid;grid-template-columns:240px 1fr;gap:20px;align-items:stretch;margin:8px 0 28px}
.score{background:var(--ink);color:#fff;border-radius:12px;padding:20px;display:flex;flex-direction:column;justify-content:center}
.score .lbl{font-family:"Space Grotesk",sans-serif;font-size:15px;color:#d9dde3}
.score .num{font-family:"Space Grotesk",sans-serif;font-weight:700;font-size:46px;line-height:1.05;margin-top:4px}
.score .of{font-size:14px;color:#d9dde3;margin-top:6px}
.summary{border:1px solid var(--line);border-radius:12px;padding:18px 20px;display:flex;flex-direction:column;justify-content:center}
.summary p{margin:0 0 8px}.summary p:last-child{margin:0}
h2{font-size:20px;margin:28px 0 10px}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top;font-size:14px}
th{font-family:"Space Grotesk",sans-serif;font-size:13px;color:var(--ink2);font-weight:500}
td.q{width:46%}
.st{white-space:nowrap}
.st-recommended{font-weight:700;color:var(--ink)}
.st-recommended::before{content:"\\2713\\00a0";}
.st-listed_only{font-weight:600;color:var(--ink2)}
.st-not_named{font-weight:400;color:var(--muted);font-style:italic}
.named{color:var(--ink2)}
.findings{display:grid;gap:12px}
.finding{border:1px solid var(--line);border-left:4px solid var(--ink);border-radius:10px;padding:14px 16px;display:grid;grid-template-columns:36px 1fr;gap:10px;break-inside:avoid}
.finding .n{font-family:"Space Grotesk",sans-serif;font-weight:700;font-size:22px;line-height:1}
.finding h3{font-size:15px;margin-bottom:4px}
.finding p{margin:0}
.finding .src{font-size:12px;color:var(--muted);margin-top:6px;word-break:break-all}
.offers{display:grid;grid-template-columns:1fr 1.5fr;gap:14px;margin-top:12px;align-items:stretch}
.offer{border:1px solid var(--line);border-radius:12px;padding:18px;break-inside:avoid}
.offer h3{font-size:16px}
.offer .price{font-family:"Space Grotesk",sans-serif;font-weight:700;font-size:24px;margin:6px 0}
.offer ul{margin:8px 0 12px;padding-left:18px}.offer li{margin:2px 0}
.offer.main{background:var(--blue);border-color:var(--blue);color:#fff}
.offer.main .price{font-size:32px}
.offer.main a.btn{background:#fff;color:var(--blue)}
.tag{display:inline-block;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;border:1px solid currentColor;border-radius:999px;padding:1px 8px;margin-bottom:8px}
a.btn{display:inline-block;padding:10px 16px;border-radius:8px;font-weight:700;text-decoration:none;background:var(--ink);color:#fff}
.limits{font-size:12.5px;color:var(--ink2);border-top:1px solid var(--line);margin-top:28px;padding-top:14px}
.footer{font-size:12.5px;color:var(--ink2);margin-top:8px}
.badge-sample{display:inline-block;background:var(--ink);color:#fff;font-weight:700;font-size:12px;padding:3px 10px;border-radius:6px;letter-spacing:.04em}
pre.file{white-space:pre-wrap;word-break:break-word;background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:12px;font:12.5px/1.5 ui-monospace,Menlo,monospace}
@media (max-width:640px){.hero{grid-template-columns:1fr}.offers{grid-template-columns:1fr}.top{flex-direction:column}.meta{text-align:left}h1.clinic{font-size:24px}td.q{width:auto}}
@media print{@page{size:Letter;margin:14mm 12mm}.page{padding:0;max-width:none}a{color:inherit}.offer.main a.btn{color:var(--blue)}}
`;

export function documentShell(title: string, body: string, opts: { noindex?: boolean } = {}): string {
  return `<!doctype html><html lang="en-CA"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>${opts.noindex !== false ? '<meta name="robots" content="noindex,nofollow">' : ""}
<style>${embeddedFonts()}${REPORT_CSS}</style></head><body>${body}</body></html>`;
}
