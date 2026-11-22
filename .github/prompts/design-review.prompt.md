---
description: Review the public pages against the design rules, using fresh pictures
---

Review the design of the public pages. Do not change any file in this pass; report only.

1. Read `.github/instructions/design.instructions.md`.
2. Run `npm run design:check` and report its result.
3. Make sure the site is running (`npm run dev`), then run `npm run shots -- review`. Report any page it says scrolls sideways.
4. Open the pictures in `output/shots/review/` for the pages I name (or all of them if I name none), at 390, 768 and 1280 pixels wide.
5. For each page, list what breaks the rules or looks careless, most serious first. Look for:
   - a heading, button or label that wraps badly or is cut off
   - two blocks that should line up and do not (left edges, baselines, card heights)
   - spacing that differs between sections that have the same job
   - a block that copies another page's block with small differences
   - anything from the "looks machine-made" list in the rules
   - text that is hard to read at phone width
6. For each finding give the page, the width, what is wrong, and the smallest change that fixes it using the named values and shared classes.

Finish with the three changes you would make first, and wait for me to choose before editing.
