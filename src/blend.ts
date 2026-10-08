// Masked compositing pipeline: bring ONLY the painted areas of the modified image
// into the source, as invisibly as possible.
//
// 1. Mask shaping — exact Euclidean distance to the painted edge, shifted by `grow`.
//    Every transition lives *inside* the grown mask, so nothing outside it is touched.
//    The feather adapts to stroke thickness so thin strokes still reach full strength.
// 2. Global color match — a robust (IRLS, Cauchy-weighted) 3×4 affine color transform
//    fitted from modified → source on everything outside the mask. Fixes the overall
//    color profile (white balance, saturation, levels) of the modified image.
// 3. Local tone match — the remaining source − modified residual is low-passed with a
//    robust normalized convolution outside the mask, then filled into the mask as a
//    harmonic membrane (Poisson-style seamless cloning with a smoothed boundary, so
//    jittery edges don't bleed streaks into the patch).
// 4. Detail match — optionally rescales the modified image's fine-detail energy to the
//    source's (e.g. when the modified image came out softer).
// 5. Multi-band blend (Burt–Adelson) — the difference is split into frequency bands;
//    low frequencies cross-fade over the full feather while fine detail switches over
//    a narrow seam, so slightly misaligned edges never show up as ghosted doubles.
//
// All float work happens on a padded bounding box around the mask; the rest of the
// output is a byte-exact copy of the source.

export interface BlendOptions {
  /** Pixels to dilate (+) or erode (−) the painted mask. The hard limit of what can change. */
  grow: number
  /** Width of the soft transition, in px, placed inside the grown mask edge. */
  feather: number
  /** 0..1 strength of the global affine color match. */
  globalMatch: number
  /** 0..1 strength of the local (membrane) tone match. */
  localMatch: number
  /** Gaussian σ (px) of the local tone field. Small follows local variations, large is smoother. */
  localRadius: number
  /** Residual (0..1) above which a pixel difference counts as a content change, not tone drift. */
  tolerance: number
  /** Width (px) over which fine detail switches from source to modified. ≥ feather = plain cross-fade. */
  detailSeam: number
  /** 0..1 strength of matching the modified image's fine-detail energy to the source's. */
  detailMatch: number
}

export const DEFAULT_BLEND_OPTIONS: BlendOptions = {
  grow: 4,
  feather: 24,
  globalMatch: 1,
  localMatch: 1,
  localRadius: 12,
  tolerance: 0.08,
  detailSeam: 3,
  detailMatch: 0,
}

export interface Images {
  width: number
  height: number
  /** Source RGBA. */
  source: Uint8ClampedArray
  /** Modified RGBA, already resampled/aligned to the source's size. */
  modified: Uint8ClampedArray
}

export interface BlendInput extends Images {
  /** Painted coverage per pixel (0..255); ≥ 128 counts as painted. */
  mask: Uint8Array
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface BlendResult {
  /** Final RGBA at source resolution. */
  output: Uint8ClampedArray
  /** Low-frequency blend weight per pixel (0..255) — what the feathered mask effectively is. */
  coverage: Uint8Array
  /** Padded boxes the blend worked in (one per cluster of strokes). */
  regions: Rect[]
  /** The fitted 3×4 global color transform (row-major, per output channel: r g b bias). */
  colorMatrix: Float64Array
  timings: Record<string, number>
}

const IDENTITY_AFFINE = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])
const INF = 1e20

// --- Distance transform (Felzenszwalb & Huttenlocher) ---

function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0
  v[0] = 0
  z[0] = -INF
  z[1] = INF
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = INF
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    const dq = q - v[k]
    d[q] = dq * dq + f[v[k]]
  }
}

/** Squared Euclidean distance from every pixel to the nearest pixel where `target` is set. */
function squaredDistance(target: Uint8Array, w: number, h: number): Float64Array {
  const out = new Float64Array(w * h)
  for (let i = 0; i < w * h; i++) out[i] = target[i] ? 0 : INF
  const n = Math.max(w, h)
  const f = new Float64Array(n)
  const d = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = out[y * w + x]
    edt1d(f, h, d, v, z)
    for (let y = 0; y < h; y++) out[y * w + x] = d[y]
  }
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) f[x] = out[row + x]
    edt1d(f, w, d, v, z)
    for (let x = 0; x < w; x++) out[row + x] = d[x]
  }
  return out
}

// --- Separable filters on a w×h plane ---

/**
 * Box mean with clamped windows (border windows shrink, so every output stays a true
 * local mean). Horizontal src → tmp, vertical tmp → dst; dst may alias src. The vertical
 * pass slides whole rows of column sums so memory is always walked in row order.
 */
function boxMean(src: Float32Array, w: number, h: number, r: number, dst: Float32Array, tmp: Float32Array): void {
  if (r <= 0) {
    if (dst !== src) dst.set(src)
    return
  }
  for (let y = 0; y < h; y++) {
    const row = y * w
    let sum = 0
    const initial = Math.min(r, w - 1)
    for (let x = 0; x <= initial; x++) sum += src[row + x]
    let count = initial + 1
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / count
      const add = x + r + 1
      if (add < w) {
        sum += src[row + add]
        count++
      }
      const rem = x - r
      if (rem >= 0) {
        sum -= src[row + rem]
        count--
      }
    }
  }
  const colSum = new Float64Array(w)
  const initial = Math.min(r, h - 1)
  for (let y = 0; y <= initial; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) colSum[x] += tmp[row + x]
  }
  let count = initial + 1
  for (let y = 0; y < h; y++) {
    const row = y * w
    const inv = 1 / count
    for (let x = 0; x < w; x++) dst[row + x] = colSum[x] * inv
    const add = y + r + 1
    if (add < h) {
      const ar = add * w
      for (let x = 0; x < w; x++) colSum[x] += tmp[ar + x]
      count++
    }
    const rem = y - r
    if (rem >= 0) {
      const rr = rem * w
      for (let x = 0; x < w; x++) colSum[x] -= tmp[rr + x]
      count--
    }
  }
}

/** Box radii whose 3-pass cascade approximates a Gaussian of the given σ. */
function gaussBoxRadii(sigma: number): number[] {
  const n = 3
  let wl = Math.floor(Math.sqrt((12 * sigma * sigma) / n + 1))
  if (wl % 2 === 0) wl--
  const wu = wl + 2
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4))
  const radii: number[] = []
  for (let i = 0; i < n; i++) radii.push(((i < m ? wl : wu) - 1) / 2)
  return radii
}

/** Approximate Gaussian blur (3 box passes). dst may alias src. */
function gaussBlur(src: Float32Array, w: number, h: number, sigma: number, dst: Float32Array, tmp: Float32Array): void {
  if (sigma < 0.5) {
    if (dst !== src) dst.set(src)
    return
  }
  let from = src
  for (const r of gaussBoxRadii(sigma)) {
    boxMean(from, w, h, r, dst, tmp)
    from = dst
  }
}

/** Sliding-window max (radius r) along rows then columns — O(n) via a monotonic deque. */
function maxFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const out = new Float32Array(src.length)
  const n = Math.max(w, h)
  const line = new Float32Array(n)
  const res = new Float32Array(n)
  const dq = new Int32Array(n)
  const run = (len: number) => {
    let head = 0
    let tail = 0
    for (let j = 0; j < len + r; j++) {
      if (j < len) {
        while (tail > head && line[dq[tail - 1]] <= line[j]) tail--
        dq[tail++] = j
      }
      const i = j - r
      if (i >= 0) {
        while (dq[head] < i - r) head++
        res[i] = line[dq[head]]
      }
    }
  }
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) line[x] = src[row + x]
    run(w)
    for (let x = 0; x < w; x++) out[row + x] = res[x]
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) line[y] = out[y * w + x]
    run(h)
    for (let y = 0; y < h; y++) out[y * w + x] = res[y]
  }
  return out
}

// --- Harmonic membrane fill ---

/**
 * Fill the non-`fixed` pixels of each plane with the harmonic (Laplace) interpolation
 * of the fixed ones — the membrane of Poisson cloning. Solved coarse-to-fine: each
 * level starts from the upsampled coarser solution, then Gauss–Seidel/SOR relaxes it,
 * so cost is a handful of sweeps over the unknown pixels only.
 */
function membraneFill(planes: Float32Array[], fixed: Uint8Array, w: number, h: number): void {
  const unknown: number[] = []
  for (let i = 0; i < w * h; i++) if (!fixed[i]) unknown.push(i)
  if (unknown.length === 0) return
  const idx = Int32Array.from(unknown)

  if (w <= 8 || h <= 8) {
    // Coarsest level: seed with the mean of the fixed pixels, then relax to convergence.
    for (const p of planes) {
      let sum = 0
      let count = 0
      for (let i = 0; i < w * h; i++) {
        if (fixed[i]) {
          sum += p[i]
          count++
        }
      }
      const mean = count > 0 ? sum / count : 0
      for (let k = 0; k < idx.length; k++) p[idx[k]] = mean
    }
    relax(planes, idx, w, h, 400)
    return
  }

  const cw = Math.ceil(w / 2)
  const ch = Math.ceil(h / 2)
  const cFixed = new Uint8Array(cw * ch)
  const cPlanes = planes.map(() => new Float32Array(cw * ch))
  const cCount = new Float32Array(cw * ch)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!fixed[i]) continue
      const c = (y >> 1) * cw + (x >> 1)
      cCount[c]++
      for (let p = 0; p < planes.length; p++) cPlanes[p][c] += planes[p][i]
    }
  }
  for (let c = 0; c < cw * ch; c++) {
    if (cCount[c] > 0) {
      cFixed[c] = 1
      for (const cp of cPlanes) cp[c] /= cCount[c]
    }
  }
  membraneFill(cPlanes, cFixed, cw, ch)

  // Bilinear upsample of the coarse solution as the initial guess for the unknowns.
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k]
    const x = i % w
    const y = (i - x) / w
    const fx = Math.min(cw - 1, Math.max(0, (x - 0.5) / 2))
    const fy = Math.min(ch - 1, Math.max(0, (y - 0.5) / 2))
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const x1 = Math.min(cw - 1, x0 + 1)
    const y1 = Math.min(ch - 1, y0 + 1)
    const tx = fx - x0
    const ty = fy - y0
    for (let p = 0; p < planes.length; p++) {
      const cp = cPlanes[p]
      const top = cp[y0 * cw + x0] * (1 - tx) + cp[y0 * cw + x1] * tx
      const bot = cp[y1 * cw + x0] * (1 - tx) + cp[y1 * cw + x1] * tx
      planes[p][i] = top * (1 - ty) + bot * ty
    }
  }
  relax(planes, idx, w, h, 6)
}

/** SOR sweeps of the 4-neighbor Laplace equation over the listed pixels (Neumann at the box edges). */
function relax(planes: Float32Array[], idx: Int32Array, w: number, h: number, iterations: number): void {
  const omega = 1.6
  // Precomputed neighbor indices (−1 off the box edge) and 1/neighbor-count.
  const nl = new Int32Array(idx.length)
  const nr = new Int32Array(idx.length)
  const nu = new Int32Array(idx.length)
  const nd = new Int32Array(idx.length)
  const inv = new Float32Array(idx.length)
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k]
    const x = i % w
    const y = (i - x) / w
    nl[k] = x > 0 ? i - 1 : -1
    nr[k] = x < w - 1 ? i + 1 : -1
    nu[k] = y > 0 ? i - w : -1
    nd[k] = y < h - 1 ? i + w : -1
    inv[k] = 1 / (+(x > 0) + +(x < w - 1) + +(y > 0) + +(y < h - 1))
  }
  for (const pl of planes) {
    for (let it = 0; it < iterations; it++) {
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k]
        let s = 0
        if (nl[k] >= 0) s += pl[nl[k]]
        if (nr[k] >= 0) s += pl[nr[k]]
        if (nu[k] >= 0) s += pl[nu[k]]
        if (nd[k] >= 0) s += pl[nd[k]]
        pl[i] += omega * (s * inv[k] - pl[i])
      }
    }
  }
}

// --- Global color transform ---

function solve4(m: Float64Array, b: Float64Array): Float64Array {
  // Gaussian elimination with partial pivoting on a 4×4 system (m is row-major, consumed).
  const x = new Float64Array(4)
  const a = Float64Array.from(m)
  const y = Float64Array.from(b)
  for (let col = 0; col < 4; col++) {
    let piv = col
    for (let r = col + 1; r < 4; r++) if (Math.abs(a[r * 4 + col]) > Math.abs(a[piv * 4 + col])) piv = r
    if (piv !== col) {
      for (let c = 0; c < 4; c++) [a[col * 4 + c], a[piv * 4 + c]] = [a[piv * 4 + c], a[col * 4 + c]]
      ;[y[col], y[piv]] = [y[piv], y[col]]
    }
    const d = a[col * 4 + col]
    if (Math.abs(d) < 1e-12) continue
    for (let r = col + 1; r < 4; r++) {
      const f = a[r * 4 + col] / d
      for (let c = col; c < 4; c++) a[r * 4 + c] -= f * a[col * 4 + c]
      y[r] -= f * y[col]
    }
  }
  for (let r = 3; r >= 0; r--) {
    let s = y[r]
    for (let c = r + 1; c < 4; c++) s -= a[r * 4 + c] * x[c]
    const d = a[r * 4 + r]
    x[r] = Math.abs(d) < 1e-12 ? 0 : s / d
  }
  return x
}

/**
 * Robust affine fit modified → source over the pixels not flagged in `excluded`.
 * IRLS with Cauchy weights downweights content changes; a light ridge pulls toward
 * identity so a colorless scene can't produce a wild transform.
 */
export function fitColorAffine(
  source: Uint8ClampedArray,
  modified: Uint8ClampedArray,
  width: number,
  height: number,
  excluded: Uint8Array,
  tolerance: number,
): Float64Array {
  const stride = Math.max(1, Math.floor(Math.sqrt((width * height) / 120_000)))
  const s: number[] = []
  const m: number[] = []
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const i = y * width + x
      if (excluded[i]) continue
      const p = i * 4
      s.push(source[p] / 255, source[p + 1] / 255, source[p + 2] / 255)
      m.push(modified[p] / 255, modified[p + 1] / 255, modified[p + 2] / 255)
    }
  }
  const n = s.length / 3
  if (n < 64) return IDENTITY_AFFINE.slice()

  const A = IDENTITY_AFFINE.slice()
  const tol2 = tolerance * tolerance
  for (let it = 0; it < 5; it++) {
    const xtx = new Float64Array(16)
    const xty = new Float64Array(12)
    let wsum = 0
    for (let k = 0; k < n; k++) {
      const mr = m[k * 3]
      const mg = m[k * 3 + 1]
      const mb = m[k * 3 + 2]
      let wgt = 1
      if (it > 0) {
        const er = s[k * 3] - (A[0] * mr + A[1] * mg + A[2] * mb + A[3])
        const eg = s[k * 3 + 1] - (A[4] * mr + A[5] * mg + A[6] * mb + A[7])
        const eb = s[k * 3 + 2] - (A[8] * mr + A[9] * mg + A[10] * mb + A[11])
        wgt = 1 / (1 + (er * er + eg * eg + eb * eb) / tol2)
      }
      wsum += wgt
      const xv = [mr, mg, mb, 1]
      for (let r = 0; r < 4; r++) {
        const wx = wgt * xv[r]
        for (let c = r; c < 4; c++) xtx[r * 4 + c] += wx * xv[c]
        xty[r * 3] += wx * s[k * 3]
        xty[r * 3 + 1] += wx * s[k * 3 + 1]
        xty[r * 3 + 2] += wx * s[k * 3 + 2]
      }
    }
    for (let r = 0; r < 4; r++) for (let c = 0; c < r; c++) xtx[r * 4 + c] = xtx[c * 4 + r]
    const lambda = 0.004 * wsum
    for (let r = 0; r < 4; r++) xtx[r * 4 + r] += lambda
    for (let ch = 0; ch < 3; ch++) {
      const b = new Float64Array(4)
      for (let r = 0; r < 4; r++) b[r] = xty[r * 3 + ch] + lambda * IDENTITY_AFFINE[ch * 4 + r]
      const sol = solve4(xtx, b)
      for (let r = 0; r < 4; r++) A[ch * 4 + r] = sol[r]
    }
  }
  return A
}

// --- Regions ---

/**
 * Padded bounding boxes of the painted clusters: connected components, padded, and merged
 * while they overlap — so distant strokes don't drag the whole span between them into the
 * float work.
 */
function clusterRegions(mask: Uint8Array, W: number, H: number, pad: number): Rect[] {
  const seen = new Uint8Array(W * H)
  const boxes: number[][] = []
  const stack: number[] = []
  const visit = (i: number) => {
    if (seen[i] || mask[i] < 128) return
    seen[i] = 1
    stack.push(i)
  }
  for (let start = 0; start < W * H; start++) {
    if (seen[start] || mask[start] < 128) continue
    let x0 = W
    let y0 = H
    let x1 = -1
    let y1 = -1
    visit(start)
    while (stack.length > 0) {
      const i = stack.pop()!
      const x = i % W
      const y = (i - x) / W
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      if (x > 0) visit(i - 1)
      if (x < W - 1) visit(i + 1)
      if (y > 0) visit(i - W)
      if (y < H - 1) visit(i + W)
    }
    boxes.push([Math.max(0, x0 - pad), Math.max(0, y0 - pad), Math.min(W, x1 + pad + 1), Math.min(H, y1 + pad + 1)])
  }
  // Merge overlapping boxes until stable (a speckled mask collapses into one box early).
  let merged =
    boxes.length > 256
      ? [
          boxes.reduce((a, b) => [
            Math.min(a[0], b[0]),
            Math.min(a[1], b[1]),
            Math.max(a[2], b[2]),
            Math.max(a[3], b[3]),
          ]),
        ]
      : boxes
  for (let changed = true; changed; ) {
    changed = false
    const next: number[][] = []
    for (const b of merged) {
      const hit = next.find(a => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3])
      if (hit) {
        hit[0] = Math.min(hit[0], b[0])
        hit[1] = Math.min(hit[1], b[1])
        hit[2] = Math.max(hit[2], b[2])
        hit[3] = Math.max(hit[3], b[3])
        changed = true
      } else next.push([...b])
    }
    merged = next
  }
  return merged.map(([x0, y0, x1, y1]) => ({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }))
}

export interface Shape {
  region: Rect
  /** Signed distance to the grown mask edge (px, + inside). */
  e: Float32Array
  /** Per-pixel feather width, capped by the local half-thickness of the grown mask. */
  fe: Float32Array
}

function shapeRegion(mask: Uint8Array, W: number, region: Rect, grow: number, feather: number): Shape {
  const { x: rx, y: ry, w: rw, h: rh } = region
  const rn = rw * rh
  const inside = new Uint8Array(rn)
  const outside = new Uint8Array(rn)
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const on = mask[(ry + y) * W + rx + x] >= 128
      inside[y * rw + x] = on ? 1 : 0
      outside[y * rw + x] = on ? 0 : 1
    }
  }
  const dIn = squaredDistance(outside, rw, rh)
  const dOut = squaredDistance(inside, rw, rh)
  const e = new Float32Array(rn)
  for (let k = 0; k < rn; k++) {
    e[k] = (inside[k] ? Math.sqrt(dIn[k]) - 0.5 : -(Math.sqrt(dOut[k]) - 0.5)) + grow
  }
  // Adaptive feather: never wider than the local half-thickness of the grown mask, so a thin
  // stroke still reaches full strength along its spine.
  const fe = maxFilter(e, rw, rh, Math.ceil(feather))
  boxMean(fe, rw, rh, Math.ceil(feather / 4), fe, new Float32Array(rn))
  for (let k = 0; k < rn; k++) fe[k] = Math.max(1, Math.min(feather, fe[k]))
  return { region, e, fe }
}

// --- Main entry ---
//
// Three cacheable stages: shapeMask (mask + grow/feather/localRadius) → fitColorAffine
// (+ modified image, tolerance) → composite (everything else). `blend` runs all three.

const smoothstep = (lo: number, hi: number, v: number) => {
  if (v <= lo) return 0
  if (v >= hi) return 1
  const t = (v - lo) / (hi - lo)
  return t * t * (3 - 2 * t)
}

type Lap = (name: string) => void

function timer(): { timings: Record<string, number>; lap: Lap } {
  const timings: Record<string, number> = {}
  let t0 = performance.now()
  const lap: Lap = name => {
    const t = performance.now()
    timings[name] = Math.round(((timings[name] ?? 0) + t - t0) * 10) / 10
    t0 = t
  }
  return { timings, lap }
}

export interface MaskShape {
  regions: Rect[]
  shapes: Shape[]
  /** 1 inside the grown mask — the pixels the color fit must ignore. */
  excluded: Uint8Array
  timings: Record<string, number>
}

export type ShapeOptions = Pick<BlendOptions, 'grow' | 'feather' | 'localRadius'>

export function shapeMask(mask: Uint8Array, W: number, H: number, opts: ShapeOptions): MaskShape {
  const { timings, lap } = timer()
  const feather = Math.max(1, opts.feather)
  // Room around the grown mask for the blurs and the membrane's boundary.
  const pad = Math.ceil(Math.max(0, opts.grow) + Math.max(3 * opts.localRadius, 2 * feather, 16) + 4)
  const regions = clusterRegions(mask, W, H, pad)
  const shapes = regions.map(r => shapeRegion(mask, W, r, opts.grow, feather))
  const excluded = new Uint8Array(W * H)
  for (const { region: r, e } of shapes) {
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) if (e[y * r.w + x] > 0) excluded[(r.y + y) * W + r.x + x] = 1
    }
  }
  lap('mask')
  return { regions, shapes, excluded, timings }
}

export function composite(images: Images, shape: MaskShape, fitted: Float64Array, opts: BlendOptions): BlendResult {
  const { timings, lap } = timer()
  const output = new Uint8ClampedArray(images.source)
  const coverage = new Uint8Array(images.width * images.height)
  const A = new Float64Array(12)
  for (let j = 0; j < 12; j++) A[j] = IDENTITY_AFFINE[j] + opts.globalMatch * (fitted[j] - IDENTITY_AFFINE[j])
  for (const s of shape.shapes) blendRegion(images, s, A, opts, output, coverage, lap)
  return { output, coverage, regions: shape.regions, colorMatrix: fitted, timings }
}

export function blend(input: BlendInput, opts: BlendOptions): BlendResult {
  const { width: W, height: H, source, modified, mask } = input
  const shape = shapeMask(mask, W, H, opts)
  const t = performance.now()
  const fitted = fitColorAffine(source, modified, W, H, shape.excluded, opts.tolerance)
  const global = Math.round((performance.now() - t) * 10) / 10
  const result = composite(input, shape, fitted, opts)
  result.timings = { ...shape.timings, global, ...result.timings }
  return result
}

function blendRegion(
  input: Images,
  shape: Shape,
  A: Float64Array,
  opts: BlendOptions,
  output: Uint8ClampedArray,
  coverage: Uint8Array,
  lap: Lap,
): void {
  const { width: W, source, modified } = input
  const { region, e, fe } = shape
  const { x: rx, y: ry, w: rw, h: rh } = region
  const rn = rw * rh
  const feather = Math.max(1, opts.feather)
  const tmp = new Float32Array(rn)
  const planes = () => [new Float32Array(rn), new Float32Array(rn), new Float32Array(rn)]

  const S = planes()
  const M = planes()
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const k = y * rw + x
      const p = ((ry + y) * W + rx + x) * 4
      S[0][k] = source[p] / 255
      S[1][k] = source[p + 1] / 255
      S[2][k] = source[p + 2] / 255
      const mr = modified[p] / 255
      const mg = modified[p + 1] / 255
      const mb = modified[p + 2] / 255
      M[0][k] = A[0] * mr + A[1] * mg + A[2] * mb + A[3]
      M[1][k] = A[4] * mr + A[5] * mg + A[6] * mb + A[7]
      M[2][k] = A[8] * mr + A[9] * mg + A[10] * mb + A[11]
    }
  }
  lap('planes')

  // Local tone field: robust normalized blur of the residual outside, harmonic membrane inside.
  if (opts.localMatch > 0) {
    const tol2 = opts.tolerance * opts.tolerance
    const wgt = new Float32Array(rn)
    const D = planes()
    for (let k = 0; k < rn; k++) {
      if (e[k] > 0) continue
      const dr = S[0][k] - M[0][k]
      const dg = S[1][k] - M[1][k]
      const db = S[2][k] - M[2][k]
      const wk = 1 / (1 + (dr * dr + dg * dg + db * db) / tol2)
      wgt[k] = wk
      D[0][k] = wk * dr
      D[1][k] = wk * dg
      D[2][k] = wk * db
    }
    gaussBlur(wgt, rw, rh, opts.localRadius, wgt, tmp)
    for (const d of D) gaussBlur(d, rw, rh, opts.localRadius, d, tmp)
    const fixed = new Uint8Array(rn)
    for (let k = 0; k < rn; k++) {
      if (e[k] <= 0 && wgt[k] > 1e-3) {
        fixed[k] = 1
        const inv = 1 / wgt[k]
        D[0][k] *= inv
        D[1][k] *= inv
        D[2][k] *= inv
      }
    }
    lap('localField')
    membraneFill(D, fixed, rw, rh)
    for (let c = 0; c < 3; c++) {
      const m = M[c]
      const d = D[c]
      for (let k = 0; k < rn; k++) m[k] += opts.localMatch * d[k]
    }
    lap('membrane')
  }

  // Detail match: rescale the modified image's finest detail (4-neighbor Laplacian) so its
  // energy matches the source's on a ring just outside the mask.
  if (opts.detailMatch > 0) {
    const ring = Math.max(8, feather)
    const hp = (p: Float32Array, k: number, x: number, y: number) => {
      const l = x > 0 ? p[k - 1] : p[k]
      const r = x < rw - 1 ? p[k + 1] : p[k]
      const u = y > 0 ? p[k - rw] : p[k]
      const d = y < rh - 1 ? p[k + rw] : p[k]
      return p[k] - 0.25 * (l + r + u + d)
    }
    let es = 0
    let em = 0
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const k = y * rw + x
        if (e[k] > 0 || e[k] < -ring) continue
        for (let c = 0; c < 3; c++) {
          const hs = hp(S[c], k, x, y)
          const hm = hp(M[c], k, x, y)
          es += hs * hs
          em += hm * hm
        }
      }
    }
    if (em > 1e-9 && es > 1e-9) {
      const gain = opts.detailMatch * (Math.min(4, Math.max(0.25, Math.sqrt(es / em))) - 1)
      for (let c = 0; c < 3; c++) {
        const m = M[c]
        const detail = new Float32Array(rn)
        for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) detail[y * rw + x] = hp(m, y * rw + x, x, y)
        for (let k = 0; k < rn; k++) m[k] += gain * detail[k]
      }
    }
    lap('detail')
  }

  // Multi-band blend of the difference Δ = M − S. Band k (≈ 2^k..2^(k+1) px) switches over
  // max(detailSeam, 2^(k+1)) px, centered in the adaptive feather. Bands whose widths are
  // equal telescope into one, so a plain cross-fade needs no blur at all.
  const delta = planes()
  for (let c = 0; c < 3; c++) for (let k = 0; k < rn; k++) delta[c][k] = M[c][k] - S[c][k]
  const levels = Math.max(0, Math.ceil(Math.log2(feather)) - 1)
  const widths: number[] = []
  for (let k = 0; k < levels; k++) widths.push(Math.min(feather, Math.max(opts.detailSeam, 2 ** (k + 1))))
  widths.push(feather)
  const acc = planes()
  let low = delta
  let next = M // M is no longer needed; reuse it as the low-pass buffer.
  const spare = planes()
  for (let k = 0; k < widths.length; ) {
    let j = k
    while (j + 1 < widths.length && widths[j + 1] === widths[k]) j++
    const last = j === widths.length - 1
    if (!last) for (let c = 0; c < 3; c++) gaussBlur(delta[c], rw, rh, 2 ** (j + 1), next[c], tmp)
    const bandWidth = widths[k]
    for (let i = 0; i < rn; i++) {
      const ei = e[i]
      if (ei <= 0) continue
      const f = fe[i]
      const width = Math.min(f, bandWidth)
      const wi = smoothstep((f - width) / 2, (f + width) / 2, ei)
      if (wi === 0) continue
      for (let c = 0; c < 3; c++) acc[c][i] += wi * (last ? low[c][i] : low[c][i] - next[c][i])
    }
    if (!last) {
      const old = low === delta ? spare : low
      low = next
      next = old
    }
    k = j + 1
  }
  lap('multiband')

  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const k = y * rw + x
      if (e[k] <= 0) continue
      const gidx = (ry + y) * W + rx + x
      const p = gidx * 4
      output[p] = Math.round((S[0][k] + acc[0][k]) * 255)
      output[p + 1] = Math.round((S[1][k] + acc[1][k]) * 255)
      output[p + 2] = Math.round((S[2][k] + acc[2][k]) * 255)
      coverage[gidx] = Math.round(smoothstep(0, fe[k], e[k]) * 255)
    }
  }
  lap('composite')
}
