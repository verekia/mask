// Alignment of the modified image onto the source. Image-gen outputs can drift by a few
// pixels; `estimateOffset` finds the translation and `shiftImage` resamples with it.
//
// The search matches luminance *gradients* (insensitive to the tone/color drift the blend
// corrects anyway), coarse-to-fine: an exhaustive search on a downsampled copy, an integer
// refine at full resolution, then a parabola fit for the sub-pixel part. Painted pixels are
// ignored — they are where the two images are expected to differ.

export interface Offset {
  dx: number
  dy: number
}

/** Bilinear resample: out(x, y) = src(x − dx, y − dy), edges clamped. */
export function shiftImage(src: Uint8ClampedArray, w: number, h: number, dx: number, dy: number): Uint8ClampedArray {
  if (dx === 0 && dy === 0) return src.slice()
  const out = new Uint8ClampedArray(src.length)
  const x0 = new Int32Array(w)
  const x1 = new Int32Array(w)
  const fx = -dx - Math.floor(-dx)
  for (let x = 0; x < w; x++) {
    const sx = Math.floor(x - dx)
    x0[x] = Math.min(w - 1, Math.max(0, sx)) * 4
    x1[x] = Math.min(w - 1, Math.max(0, sx + 1)) * 4
  }
  const fy = -dy - Math.floor(-dy)
  for (let y = 0; y < h; y++) {
    const sy = Math.floor(y - dy)
    const r0 = Math.min(h - 1, Math.max(0, sy)) * w * 4
    const r1 = Math.min(h - 1, Math.max(0, sy + 1)) * w * 4
    const row = y * w * 4
    for (let x = 0; x < w; x++) {
      const a = r0 + x0[x]
      const b = r0 + x1[x]
      const c = r1 + x0[x]
      const d = r1 + x1[x]
      for (let ch = 0; ch < 4; ch++) {
        const top = src[a + ch] + (src[b + ch] - src[a + ch]) * fx
        const bot = src[c + ch] + (src[d + ch] - src[c + ch]) * fx
        out[row + x * 4 + ch] = top + (bot - top) * fy
      }
    }
  }
  return out
}

/** Box-downsampled luminance (factor f) and a matching "usable" flag (no painted pixel inside). */
function lumaPyramidLevel(
  rgba: Uint8ClampedArray,
  mask: Uint8Array | null,
  w: number,
  h: number,
  f: number,
): { lum: Float32Array; ok: Uint8Array; w: number; h: number } {
  const sw = Math.floor(w / f)
  const sh = Math.floor(h / f)
  const lum = new Float32Array(sw * sh)
  const ok = new Uint8Array(sw * sh).fill(1)
  for (let y = 0; y < sh * f; y++) {
    const srow = (y / f) | 0
    for (let x = 0; x < sw * f; x++) {
      const i = y * w + x
      const p = i * 4
      const k = srow * sw + ((x / f) | 0)
      lum[k] += 0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2]
      if (mask && mask[i] >= 128) ok[k] = 0
    }
  }
  const inv = 1 / (f * f * 255)
  for (let k = 0; k < lum.length; k++) lum[k] *= inv
  return { lum, ok, w: sw, h: sh }
}

/** Mean |∇S(x) − ∇M(x − o)| over usable pixels, sampled every `step` px. */
function gradientError(
  s: Float32Array,
  m: Float32Array,
  ok: Uint8Array,
  w: number,
  h: number,
  ox: number,
  oy: number,
  margin: number,
  step: number,
): number {
  let sum = 0
  let count = 0
  for (let y = margin; y < h - margin - 1; y += step) {
    for (let x = margin; x < w - margin - 1; x += step) {
      const i = y * w + x
      if (!ok[i]) continue
      const j = (y - oy) * w + (x - ox)
      const gxs = s[i + 1] - s[i]
      const gys = s[i + w] - s[i]
      const gxm = m[j + 1] - m[j]
      const gym = m[j + w] - m[j]
      sum += Math.abs(gxs - gxm) + Math.abs(gys - gym)
      count++
    }
  }
  return count > 0 ? sum / count : Infinity
}

function parabolaVertex(em: number, e0: number, ep: number): number {
  const denom = em - 2 * e0 + ep
  if (!(denom > 1e-12)) return 0
  return Math.max(-0.5, Math.min(0.5, (0.5 * (em - ep)) / denom))
}

/**
 * Translation (dx, dy) such that shiftImage(modified, dx, dy) best overlays the source.
 * `maxShift` bounds the search in full-resolution pixels.
 */
export function estimateOffset(
  source: Uint8ClampedArray,
  modified: Uint8ClampedArray,
  w: number,
  h: number,
  mask: Uint8Array | null,
  maxShift = 48,
): Offset {
  // Coarse: exhaustive search on a ~320 px wide copy.
  const f = Math.max(1, Math.ceil(Math.max(w, h) / 320))
  const cs = lumaPyramidLevel(source, mask, w, h, f)
  const cm = lumaPyramidLevel(modified, null, w, h, f)
  const cr = Math.max(1, Math.ceil(maxShift / f))
  let best = { x: 0, y: 0, e: Infinity }
  for (let oy = -cr; oy <= cr; oy++) {
    for (let ox = -cr; ox <= cr; ox++) {
      const e = gradientError(cs.lum, cm.lum, cs.ok, cs.w, cs.h, ox, oy, cr + 1, 1)
      if (e < best.e) best = { x: ox, y: oy, e }
    }
  }

  // Fine: integer search around the coarse hit at full resolution (subsampled grid).
  const fs = lumaPyramidLevel(source, mask, w, h, 1)
  const fm = lumaPyramidLevel(modified, null, w, h, 1)
  const margin = maxShift + f + 2
  const step = Math.max(1, Math.round(Math.sqrt((w * h) / 150_000)))
  const err = new Map<string, number>()
  const errorAt = (ox: number, oy: number) => {
    const key = `${ox},${oy}`
    let e = err.get(key)
    if (e === undefined) {
      e = gradientError(fs.lum, fm.lum, fs.ok, w, h, ox, oy, margin, step)
      err.set(key, e)
    }
    return e
  }
  const cx = best.x * f
  const cy = best.y * f
  let fx = cx
  let fy = cy
  let fe = Infinity
  for (let oy = cy - f; oy <= cy + f; oy++) {
    for (let ox = cx - f; ox <= cx + f; ox++) {
      const e = errorAt(ox, oy)
      if (e < fe) {
        fe = e
        fx = ox
        fy = oy
      }
    }
  }
  if (!Number.isFinite(fe)) return { dx: 0, dy: 0 }

  const sx = parabolaVertex(errorAt(fx - 1, fy), fe, errorAt(fx + 1, fy))
  const sy = parabolaVertex(errorAt(fx, fy - 1), fe, errorAt(fx, fy + 1))
  return { dx: Math.round((fx + sx) * 10) / 10, dy: Math.round((fy + sy) * 10) / 10 }
}
