# In The Answer: instructions for coding assistants

This is a Next.js 16 app (App Router, plain CSS modules, no Tailwind and no component library). Read `AGENTS.md` first: this version of Next.js differs from older ones, and the guides in `node_modules/next/dist/docs/` are the reference.

## Pages and stylesheets

The design rules for every page a clinic sees are in `.github/instructions/design.instructions.md`. Follow them whenever you touch a file under `src/app`. In short:

- Colours, type sizes, corner radii and shared spacing are named once in `src/app/globals.css`. Use the names; never type a value.
- Shared classes and components live in `src/app/(site)`. Reuse them before writing new CSS.
- The main pages open with a picture band (`Banner.tsx`) over a photograph of a well-equipped clinic room. The photographs are an approved set; do not add or swap one without the owner's approval.
- No gradients, shadows, blur or animation. No invented content.

Two commands check the work:

- `npm run design:check` fails on a hand-typed colour, size, radius or font, and on gradients, shadows and animation.
- `npm run shots -- <label>` (with `npm run dev` running) saves pictures of every public page at phone, tablet and desktop width in `output/shots/<label>/`, and reports any page that scrolls sideways. `npm run shots -- --compare <before> <after>` shows what changed.

Do not say a visual change is finished until both have been run and you have looked at the pictures.

## Everything else

- `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` must pass. The tests need a local Postgres (see `README.md`).
- Reports sent to clinics are built in `src/lib/reports/` with their own inline stylesheet and embedded fonts. They do not use the site's CSS; a brand change must be made in both places.
