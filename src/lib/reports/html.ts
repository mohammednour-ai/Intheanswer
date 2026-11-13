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

/**
 * The clinic's free report (renderTeaser): every class starts with "rp", so the full and monthly
 * reports, which use the classes above, are unaffected. Mobile first; the question rows become a
 * three-column table from 920px and in print. Nothing dark sits behind body text, on screen or paper.
 */
const SG = `"Space Grotesk",Inter,sans-serif`;
const TEASER_CSS = `
.rp{font-size:16px;line-height:1.55;color:var(--ink);-webkit-print-color-adjust:exact;print-color-adjust:exact}
.rp a{color:var(--ink);text-underline-offset:3px}
.rp a:hover{color:var(--blue)}
.rp p{margin:0}
.rp>main>section{display:block}
.rp-wrap{max-width:1120px;margin:0 auto;padding:0 clamp(20px,4vw,40px)}
.rp-stack{display:flex;flex-direction:column;gap:clamp(18px,2.4vw,28px)}
.rp-nowrap{white-space:nowrap}
.rp-top{padding-top:10px}
.rp-topbar{border-bottom:2px solid var(--ink);padding-bottom:10px;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:0 16px}
.rp a.rp-brand{height:44px;display:inline-flex;align-items:center;gap:10px;text-decoration:none;color:var(--ink)}
.rp-wordmark{font-family:${SG};font-weight:700;font-size:20px;letter-spacing:-.2px;white-space:nowrap}
.rp a.rp-site{min-height:44px;display:inline-flex;align-items:center;gap:6px;font-weight:600;font-size:14px;white-space:nowrap}
.rp-doc{flex:1 0 100%;font-size:14px;color:var(--muted)}
.rp-who{padding:clamp(20px,3vw,44px) 0 clamp(18px,2.4vw,32px)}
.rp-who .rp-wrap{display:flex;flex-direction:column;gap:8px}
.rp-badge{align-self:flex-start;border:1.5px solid var(--ink);border-radius:999px;padding:3px 12px;font-size:12.5px;font-weight:700;letter-spacing:.8px}
.rp .rp-eyebrow{margin:0;font-family:Inter,system-ui,sans-serif;font-size:12.5px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--muted)}
.rp-prepared{margin-top:6px!important}
.rp .rp-h1{margin:0;font-family:${SG};font-weight:700;font-size:clamp(32px,4.5vw,60px);line-height:1.04;letter-spacing:-.02em;text-wrap:balance}
.rp-meta{font-size:14.5px;color:var(--muted);text-wrap:pretty}
.rp-scoresec{padding:0 0 clamp(44px,6vw,88px)}
.rp-panel{border:2px solid var(--ink);border-radius:20px;overflow:hidden;display:flex;flex-wrap:wrap;break-inside:avoid}
.rp-score{flex:2 1 300px;min-width:0;padding:clamp(18px,2.4vw,32px);display:flex;flex-direction:column;gap:12px}
.rp-scoreline{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px 18px}
.rp-num{font-family:${SG};font-weight:700;line-height:.9;white-space:nowrap}
.rp-n{font-size:clamp(76px,7.4vw,108px);color:var(--blue)}
.rp-of{font-size:clamp(30px,2.8vw,40px);font-weight:500;color:var(--muted)}
.rp-cap{flex:1 1 130px;min-width:0;font-size:15px;line-height:1.4;color:var(--body2)}
.rp-tally{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--line);padding-top:12px}
.rp-bar{display:flex;gap:4px}
.rp-bar span{flex:1;height:10px;border-radius:5px;border:2px dashed var(--grey)}
.rp-bar .s-listed_only{border:2px solid var(--blue)}
.rp-bar .s-recommended{border:0;background:var(--blue)}
.rp-counts{font-size:13.5px;color:var(--body2)}
.c-recommended{color:var(--blue)}.c-listed_only{color:var(--amber)}.c-not_named{color:var(--red)}
.rp-summary{flex:3 1 360px;min-width:0;background:var(--ground);padding:clamp(18px,2.4vw,32px);display:flex;flex-direction:column;gap:12px}
.rp-headline{font-family:${SG};font-weight:700;font-size:clamp(24px,2.3vw,32px);line-height:1.12;letter-spacing:-.01em}
.rp-text{color:var(--body2);max-width:62ch;text-wrap:pretty}
.rp .rp-h2{margin:0;font-family:${SG};font-weight:700;font-size:clamp(26px,3vw,40px);line-height:1.1;letter-spacing:-.015em;text-wrap:balance}
.rp .rp-h3{margin:0;font-family:${SG};font-weight:700;font-size:20px;line-height:1.25}
.rp .rp-h3s{margin:0;font-family:Inter,system-ui,sans-serif;font-size:13px;font-weight:600;color:var(--muted)}
.rp-qsec{padding:0 0 clamp(48px,6.5vw,96px)}
.rp-qhead{display:none}
.rp-qlist{list-style:none;margin:0;padding:0;border-top:2px solid var(--ink)}
.rp-q{display:flex;flex-direction:column;gap:10px;padding:18px 0;border-bottom:1px solid var(--line);break-inside:avoid}
.rp-status{display:flex;align-items:center;gap:10px}
.rp-status svg{flex:0 0 auto}
.rp-word{font-family:${SG};font-weight:700;font-size:18px}
.rp-question{display:flex;gap:12px;font-weight:500;text-wrap:pretty}
.rp-qn{flex:0 0 16px;font-family:${SG};font-weight:700;color:var(--muted)}
.rp-named{display:flex;flex-direction:column;gap:6px;min-width:0}
.rp-namedlabel{font-size:13px;font-weight:600;color:var(--muted)}
.rp-chips{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px;font-size:14.5px}
.rp-chips li{border:1px solid var(--line);background:var(--ground);border-radius:999px;padding:3px 12px}
.rp-none{font-size:14.5px;color:var(--muted)}
.rp-legend{display:flex;flex-direction:column;gap:12px;break-inside:avoid}
.rp-keys{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));border:1px solid var(--line);border-radius:14px;overflow:hidden}
.rp-keys li{display:flex;align-items:center;gap:14px;padding:14px 16px;box-shadow:0 0 0 .5px var(--line2)}
.rp-keys svg{flex:0 0 auto}
.rp-keys li>span{display:flex;flex-direction:column}
.rp-keys .rp-word{font-size:19px;line-height:1.25}
.rp-def{font-size:14.5px;color:var(--body2)}
.rp-fine{font-size:14px;color:var(--muted)}
.rp-band{border-top:1px solid var(--line2);padding:clamp(48px,6.5vw,96px) 0}
.rp-band .rp-stack{gap:clamp(20px,2.6vw,32px)}
.rp-findings{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(290px,100%),1fr));gap:clamp(14px,1.8vw,24px)}
.rp-finding{background:var(--ground);border-radius:14px;padding:clamp(18px,2vw,24px);display:flex;flex-direction:column;gap:10px;break-inside:avoid}
.rp-fhead{display:flex;align-items:baseline;gap:12px}
.rp-fn{font-family:${SG};font-size:28px;line-height:1;font-weight:700;color:var(--blue)}
.rp-finding p{color:var(--body2);overflow-wrap:anywhere;text-wrap:pretty}
.rp-finding .rp-src{font-size:13px;color:var(--muted)}
.rp-live:empty{display:none}
.rp-live{padding-bottom:clamp(48px,6.5vw,96px)}
.rp-live table{font-size:14.5px}.rp-live .key{font-size:13px}.rp-live h2{font-size:20px;font-weight:700}
.rp-planshead{display:flex;flex-wrap:wrap;align-items:flex-end;gap:12px clamp(24px,4vw,64px)}
.rp-planshead .rp-h2{flex:1 1 360px;min-width:0}
.rp-planshead p{flex:1 1 380px;min-width:0;color:var(--body2);text-wrap:pretty}
.rp-glance{list-style:none;margin:0;padding:0;border-top:2px solid var(--ink);font-size:14.5px;color:var(--body2)}
.rp-glance li{padding:9px 0;border-bottom:1px solid var(--line)}
.rp-glance strong{display:block;color:var(--ink)}
.rp-plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(290px,100%),1fr));gap:clamp(16px,1.8vw,24px);align-items:stretch}
.rp-plan{border:1.5px solid var(--line);border-radius:20px;padding:clamp(20px,2.2vw,28px);display:flex;flex-direction:column;gap:16px;break-inside:avoid}
.rp-plan.main{border:2px solid var(--ink)}
.rp-planhead{display:flex;flex-direction:column;gap:6px}
.rp .rp-planname{margin:0;font-family:Inter,system-ui,sans-serif;font-size:13px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--muted)}
.rp .main .rp-planname{color:var(--ink)}
.rp-price{font-family:${SG};font-weight:700;font-size:44px;line-height:1;letter-spacing:-.02em}
.rp-price small{font-size:16px;font-weight:500;letter-spacing:0;color:var(--muted)}
.rp-plansub{font-size:15px;font-weight:600}
.rp-dl{margin:0;display:flex;flex-direction:column;border-top:2px solid var(--ink)}
.rp-dl>div{padding:12px 0;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:2px}
.rp-dl dt{font-size:12.5px;font-weight:600;letter-spacing:.6px;text-transform:uppercase;color:var(--muted)}
.rp-dl dd{margin:0}
.rp-big{font-family:${SG};font-weight:700;font-size:21px;line-height:1.25}
.rp-installs{min-height:30px;display:flex;align-items:center}
.rp-term{display:flex;flex-direction:column;gap:8px}
.rp-meter{display:flex;gap:3px}
.rp-meter span{flex:1;height:10px;border-radius:3px;background:var(--line2)}
.rp-meter span.on{background:var(--ink)}
.rp-retest{font-weight:600}
.rp-wedo{display:inline-flex;align-items:center;border-radius:999px;background:var(--blue);color:#fff;padding:3px 12px;font-weight:600;font-size:15px}
.rp-plan>p{font-size:15px;color:var(--body2);text-wrap:pretty}
.rp-plan ul{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;font-size:15px;color:var(--body2)}
.rp a.rp-btn{margin-top:auto;min-height:52px;display:flex;align-items:center;justify-content:center;gap:10px;padding:0 20px;border:1.5px solid var(--ink);border-radius:8px;background:#fff;color:var(--ink);font-weight:600;text-decoration:none}
.rp a.rp-btn:hover{background:var(--ground);color:var(--ink)}
.rp-note{border-top:1px solid var(--line2);padding-top:16px;font-size:13.5px;color:var(--muted)}
.rp-note a{font-weight:600}
.rp-foot{padding:0 0 clamp(32px,4vw,52px)}
.rp-footin{border-top:2px solid var(--ink);padding-top:clamp(22px,2.8vw,36px);display:flex;flex-direction:column;gap:16px}
.rp .rp-footin .byline{background:none;border-radius:0;padding:0;margin:0;align-items:flex-start;gap:12px;max-width:78ch;font-size:15px;line-height:1.55;color:var(--body2)}
.rp-footin .byline svg{flex:0 0 auto}
.rp-limits{font-size:13.5px;color:var(--muted);max-width:90ch;text-wrap:pretty}
.rp-contact{border-top:1px solid var(--line2);padding-top:12px;font-size:13.5px;color:var(--muted);overflow-wrap:anywhere}
@media (min-width:920px){
.rp-qhead,.rp-q{display:grid;grid-template-columns:minmax(0,2.1fr) minmax(0,5fr) minmax(0,3.9fr);gap:10px 24px;align-items:start}
.rp-qhead{padding-bottom:10px;font-size:13px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:var(--muted)}
.rp-namedlabel{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.rp-glance{display:none}
.rp-plansub{min-height:46px}
.rp-retest{min-height:48px}
}
@media print{
.rp{font-size:12px;line-height:1.5}
.rp-wrap{max-width:none;padding:0}
.rp-who{padding:16px 0 14px}
.rp .rp-h1{font-size:34px}
.rp-scoresec{padding:0 0 26px}
.rp-panel{border-radius:14px}
.rp-score,.rp-summary{padding:16px 18px;gap:10px}
.rp-n{font-size:64px}.rp-of{font-size:26px}.rp-cap{font-size:12.5px}
.rp-counts{font-size:12px}
.rp-headline{font-size:20px}
.rp .rp-h2{font-size:22px}
.rp-stack{gap:14px}
.rp-qsec{padding:0 0 26px}
.rp-band{padding:26px 0}
.rp-qhead,.rp-q{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(0,4.3fr) minmax(0,3fr);gap:6px 16px;align-items:start}
.rp-qhead{padding-bottom:6px;font-size:12px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:var(--muted)}
.rp-namedlabel{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.rp-q{padding:9px 0}
.rp-status svg{width:24px;height:21px}
.rp-word{font-size:14px}
.rp-chips,.rp-none{font-size:12px}
.rp-chips li{padding:1px 9px}
.rp-keys{grid-template-columns:repeat(3,minmax(0,1fr))}.rp-keys li{padding:9px 12px;gap:10px}.rp-keys svg{width:28px;height:24px}
.rp-keys .rp-word{font-size:14px}.rp-def,.rp-fine{font-size:12px}
.rp-findings{grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.rp-finding{padding:14px}
.rp-fn{font-size:22px}.rp .rp-h3{font-size:15px}
.rp-finding .rp-src{font-size:12px}
.rp-live{padding-bottom:26px}
.rp-live table,.rp-live .key{font-size:12px}
.rp-glance{display:none}
.rp-plansec{break-before:page;border-top:0;padding:0 0 18px}
.rp-plans{grid-template-columns:none;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:12px}
.rp-plan{padding:14px 16px;gap:8px;border-radius:14px}
.rp-plan ul{gap:3px}
.rp .rp-planname{font-size:12px}
.rp-price{font-size:30px}.rp-price small{font-size:12px}
.rp-plansub{font-size:12px;min-height:36px}
.rp-dl>div{padding:8px 0}
.rp-dl dt{font-size:12px}
.rp-big{font-size:15px}
.rp-installs{min-height:24px}
.rp-retest{min-height:36px}
.rp-meter span{height:7px}
.rp-wedo{font-size:12px;padding:2px 10px}
.rp-plan>p,.rp-plan ul{font-size:12px}
.rp a.rp-btn{min-height:38px;padding:0 12px}
.rp-note,.rp-limits,.rp-contact{font-size:12px}
.rp-foot{padding:0}
.rp-footin{padding-top:12px;gap:8px}
.rp .rp-footin .byline{font-size:12.5px}
}
`;

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
${TEASER_CSS}`;

export function documentShell(title: string, body: string, opts: { noindex?: boolean } = {}): string {
  return `<!doctype html><html lang="en-CA"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>${opts.noindex !== false ? '<meta name="robots" content="noindex,nofollow">' : ""}
<style>${embeddedFonts()}${REPORT_CSS}</style></head><body>${body}</body></html>`;
}
