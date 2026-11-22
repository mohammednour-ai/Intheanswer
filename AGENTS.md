<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Design rules

Before changing any page or stylesheet under `src/app`, read `.github/instructions/design.instructions.md`. Colours, type sizes, corner radii and shared spacing are named once in `src/app/globals.css`; use the names and never type a value. After a change run `npm run design:check`, then `npm run shots -- <label>` (with `npm run dev` running) and look at the pictures at phone, tablet and desktop width.
