/**
 * Fails when a stylesheet or a page under src/app leaves the design system.
 *
 *   npm run design:check
 *
 * The rules it enforces are the ones a person or an assistant can break without noticing:
 *   - a colour typed by hand (colours are named once, in the :root block of globals.css)
 *   - a type size that is not one of the named sizes (--text-*)
 *   - a corner radius that is not one of the named radii (--radius-*)
 *   - a font other than the two brand fonts (--font-head, --font-body)
 *   - a gradient, a shadow, a blur or an animation (the brand has none)
 *   - a size, radius, font or shadow written inline on a page a clinic sees
 *
 * The written rules, with the reasons, are in .github/instructions/design.instructions.md.
 * Report HTML (src/lib/reports) is styled separately and is not checked here.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const APP = path.join(ROOT, "src", "app");
const GLOBALS = path.join(APP, "globals.css");
/** Pages a clinic sees. The owner's portal is exempt from the inline-style rule for now. */
const PUBLIC_DIRS = ["(site)", "buy", "call", "intake", "approve"].map((d) => path.join(APP, d) + path.sep);

type Finding = { file: string; line: number; message: string };
const findings: Finding[] = [];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(css|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;
/** Comments become spaces, so line numbers stay true and commented-out values are not checked. */
const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

function topLevelParts(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if ((ch === " " || ch === "/") && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function checkCss(file: string) {
  const css = withoutComments(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
  const isGlobals = file === GLOBALS;
  const add = (index: number, message: string) => findings.push({ file, line: lineOf(css, index), message });

  // Colours: only the :root block of globals.css may spell one out.
  const root = isGlobals ? /:root\s*\{[^}]*\}/.exec(css) : null;
  const rootStart = root ? root.index : -1;
  const rootEnd = root ? root.index + root[0].length : -1;
  for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    if (m.index >= rootStart && m.index < rootEnd) continue;
    add(m.index, `colour ${m[0]} is typed by hand. Use a colour name from the :root block of src/app/globals.css.`);
  }

  if (/@keyframes\b/.test(css)) add(css.search(/@keyframes\b/), "animation (@keyframes). The brand has no motion beyond hover and focus states.");

  for (const m of css.matchAll(/(?<![\w-])([a-z][a-z0-9-]*)\s*:\s*([^;{}]+?)\s*(?=[;}])/g)) {
    const prop = m[1];
    const value = m[2].trim();
    if (/gradient\(/.test(value)) add(m.index, `gradient in "${prop}". The brand uses flat colour only.`);
    if ((prop === "box-shadow" || prop === "text-shadow") && value !== "none") add(m.index, `${prop}. The brand has no shadows; separate things with a rule, a border or the soft ground.`);
    if ((prop === "filter" || prop === "backdrop-filter") && /blur|drop-shadow/.test(value)) add(m.index, `${prop}: ${value}. The brand has no blur or glass effects.`);
    if (prop === "animation" || prop === "animation-name") add(m.index, "animation. The brand has no motion beyond hover and focus states.");

    if (prop === "font-size" && !/^var\(--text-[a-z0-9-]+\)$/.test(value) && !/^\d*\.?\d+em$/.test(value) && value !== "inherit") {
      add(m.index, `font-size: ${value}. Use a named size, var(--text-…), from src/app/globals.css.`);
    }
    if (prop === "font" && value !== "inherit" && !/var\(--text-[a-z0-9-]+\)/.test(value)) {
      add(m.index, `font: ${value}. The size in it must be a named size, var(--text-…).`);
    }
    if (prop === "font-family" && !isGlobals && !/^(var\(--font-(head|body)\)|inherit)$/.test(value)) {
      add(m.index, `font-family: ${value}. Use var(--font-head) or var(--font-body).`);
    }
    if (/^border(-[a-z]+){0,2}-radius$/.test(prop)) {
      const bad = topLevelParts(value).filter((part) => !/^(var\(--radius-[a-z0-9-]+\)|0|50%|inherit)$/.test(part));
      if (bad.length) add(m.index, `${prop}: ${value}. Use a named radius, var(--radius-…), from src/app/globals.css.`);
    }
  }
}

function checkTsx(file: string) {
  const src = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const add = (index: number, message: string) => findings.push({ file, line: lineOf(src, index), message });

  // A quoted colour, such as fill="#1F4FD8". Links to a place on the page (href="#faq") are not colours.
  for (const m of src.matchAll(/(["'`])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\1/g)) {
    if (/href=\{?$/.test(src.slice(Math.max(0, m.index - 6), m.index))) continue;
    add(m.index, `colour ${m[0]} is typed by hand. Use a class, or var(--…) with a colour name from src/app/globals.css.`);
  }

  if (PUBLIC_DIRS.some((d) => file.startsWith(d))) {
    for (const m of src.matchAll(/\b(fontSize|fontFamily|borderRadius|boxShadow)\s*:/g)) {
      add(m.index, `${m[1]} is set inline. Put it in the page's stylesheet, using a named value.`);
    }
  }
}

const files = walk(APP);
for (const f of files) (f.endsWith(".css") ? checkCss : checkTsx)(f);

if (findings.length) {
  for (const f of findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    console.error(`${path.relative(ROOT, f.file).replace(/\\/g, "/")}:${f.line}  ${f.message}`);
  }
  console.error(`\ndesign check: ${findings.length} finding(s). The rules are in .github/instructions/design.instructions.md.`);
  process.exit(1);
}
console.log(`design check passed (${files.length} files)`);
