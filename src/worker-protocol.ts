// Messages between the main thread and the blend worker (kept apart from the worker module so
// importing the types never pulls the worker file into the main bundle).

import type { BlendOptions } from './blend'

export type WorkerRequest =
  | {
      type: 'images'
      width: number
      height: number
      source: Uint8ClampedArray
      modified: Uint8ClampedArray
      modifiedVersion: number
    }
  // `mask` is null when unchanged since the last request (the worker keeps the last one).
  | { type: 'blend'; id: number; mask: Uint8Array | null; maskVersion: number; opts: BlendOptions }

/** Every blend request gets exactly one response, so the caller can track what's in flight. */
export type WorkerResponse =
  | {
      type: 'result'
      id: number
      output: Uint8ClampedArray
      coverage: Uint8Array
      regions: number
      timings: Record<string, number>
    }
  | { type: 'skipped'; id: number }
  | { type: 'error'; id: number; message: string }
