# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Mask is a single-page, client-only tool that **stabilizes image-gen edits**. The user drops a source
image and a modified version (an edit that also drifted slightly everywhere), paints the areas that
are allowed to change, and Mask composites only those areas into the source — color-matched and
seamlessly blended. Outside the grown mask the output is byte-exact source pixels; the output always
has the source's resolution (the modified image is resampled to it).

## Development Commands

```bash
bun install
bun dev            # portless mask next dev (Next 16, Turbopack)
bun run build      # static export (output: 'export')
bun run all        # format:check + lint + typecheck + warden — run before considering work done
bun run typecheck  # tsc --noEmit
bun run lint       # oxlint .
bun run format     # oxfmt . (auto-fix)
```

## Architecture

Next.js Pages Router, but it's really a vanilla-TS app: `pages/index.tsx` dynamically imports
`MainView` with `ssr: false`, and almost all logic lives in `src/`.

- **`src/blend.ts`** — the CPU compositing pipeline (pure, no DOM), in three cacheable stages:
  `shapeMask` (clusters → padded regions, signed distance + adaptive feather) → `fitColorAffine`
  (robust global 3×4 color transform outside the mask) → `composite` (local tone membrane, detail
  match, change gate, multi-band blend per region). `blend()` runs all three. The change gate is a
  drift-tolerant Oklab difference matte that multiplies the blend weights, so it can only narrow
  what the mask lets through.
- **`src/blend.worker.ts`** — runs the pipeline off the main thread and caches the shape and color
  fit between requests. Every `blend` request gets exactly one reply (`result` / `skipped` /
  `error`); the main thread keeps one request in flight and coalesces the rest (latest wins).
- **`src/align.ts`** — sub-pixel `shiftImage` and the gradient-matching `estimateOffset` (Auto).
- **`src/editor.ts`** — the viewport: zoom/pan transform over the stacked full-resolution canvases,
  the brush (mask = red canvas, alpha = coverage), undo/redo.
- **`src/config.ts`** — `.mask.json` (de)serialization for save/load.
- **`src/main-init.ts`** — the glue. Owns a **control registry** (`sliders` / `radios` / `switches`) that drives
  DOM binding, value-label formatting, AND config save/load from one source of truth. Handles slot
  loading and drop routing, the worker, views and keyboard shortcuts.
- **`src/MainView.tsx`** — static JSX markup only (controls, canvases). Control `id`s here must match
  the registry in `main-init.ts`.
- **`global.css`** — Tailwind v4 + component styles.

Data flow: files → source canvas + resized/shifted modified → worker (`images`) → mask from the
editor → worker (`blend`) → result + coverage canvases.

## Conventions & gotchas

- **Warden** (`@verekia/warden`, run by `bun run all`) enforces shared config/versions across the
  user's repos. Keep `next`/`react`/`typescript`/`oxfmt`/`oxlint`/etc. at their pinned versions and
  keep the `format`/`lint`/`warden` scripts intact. **Avoid adding npm dependencies** — everything is
  doable with `react` + vanilla TS.
- **Formatting/lint**: oxfmt (no semicolons, single quotes, 120 cols, trailing commas) + oxlint.
  `tsconfig` has `noUnusedLocals`/`noUnusedParameters`, so no unused imports/vars.
- **Adding a control**: add the markup (with a unique `id`) in `MainView.tsx`, then one entry to the
  matching registry array in `main-init.ts`. That auto-wires the event handler, value label, and
  config save/load — don't hand-wire listeners. Blend options also live in `BlendOptions`; a new one
  that affects `shapeMask` or the color fit must be added to the worker's cache keys.
- **Strictness is the contract**: nothing outside the grown mask may change. Every blend weight is
  0 at `e ≤ 0` (signed distance to the grown edge) and only `e > 0` pixels are written.
- **Thin strokes**: keep blend weights evaluated per pixel at full resolution. A downsampled
  Laplacian pyramid would average a thin stroke's low frequencies away (washed-out patch).
- **Hot loops** belong in small functions: JS engines optimize those far better than loops inline
  in one big function.
- **Worker bundling**: Turbopack bundles `new Worker(new URL('./blend.worker.ts', import.meta.url))`
  properly, but also copies the raw `.ts` into `out/_next/static/media/`. That's why `tsconfig`
  excludes `out` (otherwise the next `next build` type-checks the stray copy and fails). Import the
  message types from `worker-protocol.ts`, never from the worker module.
- **JSX text**: in this toolchain the leading space of a multi-line JSX text node that follows an
  inline element (`<b>x</b> more text…`) gets dropped, and oxfmt rewrites `{' '}` back to a plain
  space. Use `&nbsp;` there.
