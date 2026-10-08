// Runs the blend off the main thread and caches its expensive stages between requests:
// the mask shape only depends on the mask + grow/feather/localRadius, and the global color
// fit additionally on the modified image + tolerance. Everything else reruns per request.

import { composite, fitColorAffine, shapeMask, type BlendOptions, type Images, type MaskShape } from './blend'
import type { WorkerRequest, WorkerResponse } from './worker-protocol'

let images: (Images & { modifiedVersion: number }) | null = null
let lastMask: Uint8Array | null = null
let shapeCache: { key: string; shape: MaskShape } | null = null
let fitCache: { key: string; fitted: Float64Array } | null = null

const reply = (response: WorkerResponse, transfer: Transferable[] = []) => postMessage(response, { transfer })

addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data
  if (msg.type === 'images') {
    const sizeChanged = !images || images.width !== msg.width || images.height !== msg.height
    images = msg
    fitCache = null
    if (sizeChanged) shapeCache = null
    return
  }
  if (msg.mask) lastMask = msg.mask
  if (!images || !lastMask || lastMask.length !== images.width * images.height) {
    reply({ type: 'skipped', id: msg.id })
    return
  }
  try {
    reply(...runBlend(images, lastMask, msg.maskVersion, msg.opts, msg.id))
  } catch (err) {
    reply({ type: 'error', id: msg.id, message: (err as Error).message })
  }
})

function runBlend(
  imgs: Images & { modifiedVersion: number },
  mask: Uint8Array,
  maskVersion: number,
  opts: BlendOptions,
  id: number,
): [WorkerResponse, Transferable[]] {
  const t0 = performance.now()
  const timings: Record<string, number> = {}

  const shapeKey = `${maskVersion}|${imgs.width}x${imgs.height}|${opts.grow}|${opts.feather}|${opts.localRadius}`
  if (shapeCache?.key !== shapeKey) {
    const shape = shapeMask(mask, imgs.width, imgs.height, opts)
    shapeCache = { key: shapeKey, shape }
    fitCache = null
    Object.assign(timings, shape.timings)
  }
  const { shape } = shapeCache

  const fitKey = `${shapeKey}|${imgs.modifiedVersion}|${opts.tolerance}`
  if (fitCache?.key !== fitKey) {
    const t = performance.now()
    const fitted = fitColorAffine(imgs.source, imgs.modified, imgs.width, imgs.height, shape.excluded, opts.tolerance)
    fitCache = { key: fitKey, fitted }
    timings.global = Math.round((performance.now() - t) * 10) / 10
  }

  const result = composite(imgs, shape, fitCache.fitted, opts)
  Object.assign(timings, result.timings, { total: Math.round(performance.now() - t0) })
  const response: WorkerResponse = {
    type: 'result',
    id,
    output: result.output,
    coverage: result.coverage,
    regions: shape.regions.length,
    timings,
  }
  return [response, [result.output.buffer, result.coverage.buffer]]
}
