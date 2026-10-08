# MASK

**Stabilize image-gen edits with a painted mask.** Image models rarely change only what you asked
for: an edit of a face also nudges colors, shapes and edges everywhere else. Drop the **source**
image and the **modified** one, paint the areas that are allowed to change, and Mask brings _only_
those areas over — color-matched to the source and blended in with an invisible seam. Every pixel
outside the painted area (plus an adjustable **Grow** margin) stays the exact source pixel, at the
source's resolution.

```bash
bun install
bun dev
```

## Workflow

1. **Drop the images** onto their slots (or anywhere — files named `source…`, `modified…` / `edit…`
   and `mask…` are routed automatically). The modified image is resized to the source if needed.
2. **Paint** over the source where changes are allowed — or drop a mask image (its alpha, or
   anything that differs from its background color, marks the editable areas).
3. **Compare** — the Result / Source toggle (or `C`) flips the two on top of each other.
4. **Download** the result as a PNG at the source's resolution. `Save mask` exports the mask.

Controls: drag paints, Alt-drag erases (`X` swaps modes), `[` `]` resize the brush, Space-drag or
right-drag pans, ⌘/Ctrl+scroll or pinch zooms, scroll pans, `F` fits, `1` shows actual pixels,
⌘/Ctrl+Z undoes.

## Pipeline

All of it runs in a Web Worker, on padded boxes around each cluster of strokes.

1. **Mask shaping** — exact Euclidean distance to the painted edge, shifted by **Grow**. The grown
   mask is a hard limit: every transition lives inside it. The **Feather** narrows automatically
   on thin strokes, so a 6 px stroke over a mouth still reaches full strength along its spine.
2. **Global color match** — a robust (IRLS, Cauchy-weighted) 3×4 affine color transform fitted from
   modified → source on everything outside the mask, so the patch adopts the source's overall
   color profile: white balance, saturation, levels.
3. **Local tone match** — the remaining source − modified residual is low-passed outside the mask
   (a normalized convolution that ignores differences above **Tolerance** as content changes), then
   filled across the mask as a harmonic membrane — Poisson-style seamless cloning, but with a
   smoothed boundary so jittery edges don't streak into the patch.
4. **Detail match** _(optional)_ — rescales the modified image's finest detail so its energy
   matches the source's around the mask, for when the edit came out softer or noisier.
5. **Change gate** _(optional)_ — inside the mask, only pixels where the color-matched modified
   image still differs strongly from the source (Oklab ΔE above **Threshold**) come through, so
   you can paint loosely: over a mouth, only the new red lips pass and a slightly lighter skin
   stays source; over a sky, a reshaped cloud swaps in while the blue stays put. A color found
   within **Drift** px in the other image counts as the same thing moved, so outlines that merely
   shifted stay source; **Spread** takes in the anti-aliased rims of changed shapes. Best for a
   distinct shape over a background of a different color — leave it off to replace a whole area.
   The **Blend** overlay shows what passes.
6. **Multi-band blend** — the difference is split into frequency bands (Burt–Adelson). Broad tone
   cross-fades over the whole feather while fine detail switches over the narrow **Detail seam**,
   so edges that don't quite line up never show as ghosted doubles.

**Align** shifts the modified image by a sub-pixel offset; **Auto** estimates it by matching
luminance gradients coarse-to-fine, ignoring the painted areas.

## Saving settings

`Save config` writes a `<source>.mask.json` snapshot of every dial. `Load config` — or dropping a
`.json` with the images — restores them.

## License

[MIT](LICENSE)
