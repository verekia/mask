import { estimateOffset, shiftImage } from './align'
import { DEFAULT_BLEND_OPTIONS, type BlendOptions } from './blend'
import type { WorkerRequest, WorkerResponse } from './worker-protocol'
import { downloadConfig, isConfigFile, readConfigFile, type MaskSettings } from './config'
import { Editor, isTypingTarget } from './editor'

let initialized = false

const THUMB_MAX_W = 168
const THUMB_MAX_H = 112
const VALID_TYPES = ['image/png', 'image/jpeg', 'image/webp']

type SlotName = 'source' | 'modified' | 'mask'
type View = 'result' | 'source' | 'modified'
type Overlay = 'off' | 'paint' | 'blend'

const $ = (id: string) => document.getElementById(id)!

function rafThrottle(fn: () => void): () => void {
  let scheduled = false
  return () => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      fn()
    })
  }
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.addEventListener('load', () => {
      URL.revokeObjectURL(url)
      resolve(img)
    })
    img.addEventListener('error', () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to load image'))
    })
    img.src = url
  })
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Guess which slot a dropped file is meant for from its name. */
function slotFromName(name: string): SlotName | null {
  if (/mask/i.test(name)) return 'mask'
  if (/modif|edit|after|output|result/i.test(name)) return 'modified'
  if (/source|orig|before|base|input/i.test(name)) return 'source'
  return null
}

/**
 * Mask coverage from an imported image, resized to the source: its alpha when it has any
 * transparency, otherwise how far each pixel is from the background (corner) color — so
 * red-on-transparent, white-on-black and black-on-white masks all work.
 */
function maskFromImage(img: HTMLImageElement, w: number, h: number): Uint8Array {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(img, 0, 0, w, h)
  const d = ctx.getImageData(0, 0, w, h).data
  const out = new Uint8Array(w * h)
  let hasAlpha = false
  for (let i = 0; i < w * h && !hasAlpha; i++) hasAlpha = d[i * 4 + 3] < 250
  if (hasAlpha) {
    for (let i = 0; i < w * h; i++) out[i] = d[i * 4 + 3]
    return out
  }
  const corners = [0, w - 1, (h - 1) * w, h * w - 1]
  const median = (ch: number) => corners.map(i => d[i * 4 + ch]).toSorted((a, b) => a - b)[1]
  const bg = [median(0), median(1), median(2)]
  for (let i = 0; i < w * h; i++) {
    const p = i * 4
    const dist = Math.max(Math.abs(d[p] - bg[0]), Math.abs(d[p + 1] - bg[1]), Math.abs(d[p + 2] - bg[2]))
    out[i] = Math.max(0, Math.min(255, ((dist - 16) * 255) / 48))
  }
  return out
}

const radioValue = (name: string) =>
  (document.querySelector(`input[name="${name}"]:checked`) as HTMLInputElement | null)?.value ?? ''

function setRadio(name: string, value: string) {
  const el = document.querySelector(`input[name="${name}"][value="${value}"]`) as HTMLInputElement | null
  if (el) el.checked = true
}

type SliderDef = { id: string; format: (v: number) => string; apply: (v: number) => void }
/** A set of radio inputs sharing `name`. `persist` ones are saved in the config. */
type RadioDef = { name: string; persist?: boolean; apply: (value: string) => void }

export function init() {
  if (initialized) return
  initialized = true

  const errorMessage = $('error-message')
  const sectionEditor = $('section-editor')
  const canvasSource = $('canvas-source') as HTMLCanvasElement
  const canvasModified = $('canvas-modified') as HTMLCanvasElement
  const canvasResult = $('canvas-result') as HTMLCanvasElement
  const canvasCoverage = $('canvas-coverage') as HTMLCanvasElement
  const canvasMask = $('canvas-mask') as HTMLCanvasElement
  const viewport = $('viewport')
  const statusEl = $('status')
  const zoomValue = $('zoom-value')
  const viewBadge = $('view-badge')
  const compareBtn = $('btn-compare')

  let W = 0
  let H = 0
  let sourceData: Uint8ClampedArray | null = null
  let modifiedImg: HTMLImageElement | null = null
  let modifiedBase: Uint8ClampedArray | null = null
  let modifiedReady = false
  let resizeNote = ''
  let baseName = 'mask'
  let view: View = 'result'
  let overlay: Overlay = 'paint'
  let hasResult = false
  let maskVersion = 0
  let modifiedVersion = 0
  let dragCounter = 0

  const opts: BlendOptions = { ...DEFAULT_BLEND_OPTIONS }
  const offset = { dx: 0, dy: 0 }

  // --- Errors / status ---

  function showError(msg: string) {
    errorMessage.textContent = msg
    errorMessage.classList.remove('hidden')
  }

  function clearError() {
    errorMessage.classList.add('hidden')
  }

  function setStatus(text: string) {
    const size = W ? `${W}×${H}` : ''
    statusEl.textContent = [size, resizeNote, text].filter(Boolean).join(' · ')
  }

  // --- Editor (viewport + brush) ---

  const editor = new Editor(
    { viewport, content: $('viewport-content'), maskCanvas: canvasMask, cursor: $('brush-cursor') },
    {
      onMaskChange: () => {
        maskVersion++
        scheduleMaskThumb()
        scheduleBlend()
      },
      onZoomChange: z => {
        zoomValue.textContent = `${Math.round(z * 100)}%`
      },
    },
  )

  // --- Worker (latest request wins; the worker caches stages between requests) ---

  const worker = new Worker(new URL('./blend.worker.ts', import.meta.url), { type: 'module' })
  let inFlight = false
  let pending = false
  let nextId = 0
  let maskVersionSent = -1

  function requestBlend() {
    if (!sourceData || !modifiedReady) return
    if (inFlight) {
      pending = true
      return
    }
    inFlight = true
    pending = false
    // The worker keeps the last mask it was sent; only ship a new one when it changed.
    const mask = maskVersionSent === maskVersion ? null : editor.getMask()
    maskVersionSent = maskVersion
    const msg: WorkerRequest = { type: 'blend', id: ++nextId, mask, maskVersion, opts: { ...opts } }
    worker.postMessage(msg, mask ? [mask.buffer] : [])
    setStatus('blending…')
  }
  const scheduleBlend = rafThrottle(requestBlend)

  worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
    inFlight = false
    const r = event.data
    if (r.type === 'error') showError(`Blend failed: ${r.message}`)
    // A result for an image size that has since been replaced is dropped.
    if (r.type === 'result' && r.output.length === W * H * 4) {
      canvasResult.getContext('2d')!.putImageData(new ImageData(r.output as Uint8ClampedArray<ArrayBuffer>, W, H), 0, 0)
      const cov = new ImageData(W, H)
      for (let i = 0; i < r.coverage.length; i++) {
        cov.data[i * 4] = 255
        cov.data[i * 4 + 3] = r.coverage[i]
      }
      canvasCoverage.getContext('2d')!.putImageData(cov, 0, 0)
      hasResult = true
      applyView()
      const regions = r.regions === 0 ? 'empty mask' : `${r.regions} region${r.regions > 1 ? 's' : ''}`
      setStatus(`${regions} · blend ${r.timings.total} ms`)
    }
    if (pending) requestBlend()
  })
  worker.addEventListener('error', e => showError(`Blend worker failed: ${e.message}`))

  function sendImages(modified: Uint8ClampedArray) {
    if (!sourceData) return
    modifiedVersion++
    const msg: WorkerRequest = {
      type: 'images',
      width: W,
      height: H,
      source: sourceData.slice(),
      modified,
      modifiedVersion,
    }
    worker.postMessage(msg, [msg.source.buffer, modified.buffer])
    // A new image pair invalidates the worker's mask cache for a size change; resend it.
    maskVersionSent = -1
  }

  // --- Views ---

  function applyView() {
    canvasResult.classList.toggle('hidden', view !== 'result' || !hasResult)
    canvasModified.classList.toggle('hidden', view !== 'modified' || !modifiedReady)
    const label = view === 'result' ? 'Result' : view === 'source' ? 'Source' : 'Modified'
    viewBadge.textContent = view === 'result' && !hasResult ? 'Result (needs the modified image)' : label
    viewBadge.dataset.view = view
    compareBtn.setAttribute('aria-pressed', String(view === 'result'))
    compareBtn.textContent = view === 'result' ? 'Result' : 'Source'
    setRadio('view', view)
  }

  function applyOverlay() {
    canvasMask.classList.toggle('hidden', overlay !== 'paint')
    canvasCoverage.classList.toggle('hidden', overlay !== 'blend')
  }

  function setView(v: View) {
    view = v
    applyView()
  }

  // Flip result ⇄ source in place, so the two can be compared on top of each other.
  const toggleCompare = () => setView(view === 'result' ? 'source' : 'result')

  // --- Slots ---

  function drawThumb(slot: SlotName, src: CanvasImageSource, w: number, h: number) {
    const c = $(`slot-${slot}-thumb`) as HTMLCanvasElement
    const s = Math.min(THUMB_MAX_W / w, THUMB_MAX_H / h, 1)
    c.width = Math.max(1, Math.round(w * s))
    c.height = Math.max(1, Math.round(h * s))
    const ctx = c.getContext('2d')!
    ctx.clearRect(0, 0, c.width, c.height)
    ctx.drawImage(src, 0, 0, c.width, c.height)
    c.classList.remove('hidden')
    $(`slot-${slot}-hint`).classList.add('hidden')
    $(`slot-${slot}`).classList.add('filled')
  }

  const scheduleMaskThumb = rafThrottle(() => {
    if (W) drawThumb('mask', canvasMask, W, H)
  })

  // --- Loading ---

  async function loadSource(file: File) {
    const img = await loadImage(file)
    W = img.naturalWidth
    H = img.naturalHeight
    for (const c of [canvasSource, canvasModified, canvasResult, canvasCoverage]) {
      c.width = W
      c.height = H
    }
    const ctx = canvasSource.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(img, 0, 0)
    sourceData = ctx.getImageData(0, 0, W, H).data
    baseName = file.name.replace(/\.[^.]+$/, '') || 'mask'
    hasResult = false
    modifiedReady = false
    drawThumb('source', img, W, H)
    // Unhide before sizing the editor so it can fit the image to the viewport.
    sectionEditor.classList.remove('hidden')
    editor.setImageSize(W, H)
    maskVersion++
    if (modifiedImg) rebuildModified()
    else setStatus('add the modified image to blend')
    applyView()
  }

  async function loadModified(file: File) {
    modifiedImg = await loadImage(file)
    drawThumb('modified', modifiedImg, modifiedImg.naturalWidth, modifiedImg.naturalHeight)
    rebuildModified()
  }

  /** Resample the modified image to the source's size (the result always keeps the source's). */
  function rebuildModified() {
    if (!modifiedImg || !sourceData) return
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const ctx = c.getContext('2d', { willReadFrequently: true })!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(modifiedImg, 0, 0, W, H)
    modifiedBase = ctx.getImageData(0, 0, W, H).data
    const mw = modifiedImg.naturalWidth
    const mh = modifiedImg.naturalHeight
    resizeNote = mw === W && mh === H ? '' : `modified resized from ${mw}×${mh}`
    if (Math.abs(mw / mh - W / H) > 0.01) resizeNote += ' (aspect ratio differs — stretched)'
    applyOffset()
  }

  function applyOffset() {
    if (!modifiedBase || !sourceData) return
    const shifted = shiftImage(modifiedBase, W, H, offset.dx, offset.dy)
    canvasModified.getContext('2d')!.putImageData(new ImageData(shifted as Uint8ClampedArray<ArrayBuffer>, W, H), 0, 0)
    modifiedReady = true
    sendImages(shifted)
    applyView()
    scheduleBlend()
  }
  const scheduleOffset = rafThrottle(applyOffset)

  async function loadMask(file: File) {
    if (!sourceData) {
      showError('Load the source image before a mask.')
      return
    }
    const img = await loadImage(file)
    editor.setMask(maskFromImage(img, W, H))
  }

  async function loadInto(slot: SlotName, file: File) {
    if (!VALID_TYPES.includes(file.type)) {
      showError('Unsupported file type. Please use PNG, JPG, or WebP.')
      return
    }
    try {
      if (slot === 'source') await loadSource(file)
      else if (slot === 'modified') await loadModified(file)
      else await loadMask(file)
    } catch (err) {
      showError(`Error loading ${slot}: ${(err as Error).message}`)
    }
  }

  async function handleFiles(files: FileList | null | undefined, target?: SlotName) {
    if (!files || files.length === 0) return
    clearError()
    const arr = Array.from(files)
    const configFile = arr.find(isConfigFile)
    if (configFile) await loadConfigFile(configFile)
    const images = arr.filter(f => f.type.startsWith('image/'))
    if (target) {
      if (images[0]) await loadInto(target, images[0])
      return
    }
    // Assign by file name first, then fill the empty image slots in order.
    const assigned = new Map<SlotName, File>()
    for (const f of images) {
      const slot = slotFromName(f.name)
      if (slot && !assigned.has(slot)) assigned.set(slot, f)
    }
    const rest = images.filter(f => ![...assigned.values()].includes(f))
    for (const slot of ['source', 'modified'] as const) {
      const filled = slot === 'source' ? sourceData : modifiedImg
      if (!assigned.has(slot) && !filled && rest.length > 0) assigned.set(slot, rest.shift()!)
    }
    if (rest.length > 0 && assigned.size === 0) {
      showError('Both images are loaded — drop onto the Source, Modified or Mask slot to replace one.')
    } else if (images.length === 0 && !configFile) {
      showError('Unsupported file type. Please use PNG, JPG, WebP, or a .mask.json config.')
    }
    // Source first: it sets the dimensions the modified image and the mask resample to.
    for (const slot of ['source', 'modified', 'mask'] as const) {
      const f = assigned.get(slot)
      if (f) await loadInto(slot, f)
    }
  }

  // --- Control registry (drives binding + config save/load) ---

  const blendSlider = (id: string, unit: string, set: (v: number) => void): SliderDef => ({
    id,
    format: v => `${v}${unit}`,
    apply: v => {
      set(v)
      scheduleBlend()
    },
  })

  const sliders: SliderDef[] = [
    {
      id: 'brush-size',
      format: v => `${v} px`,
      apply: v => {
        editor.brushSize = v
        editor.updateCursorSize()
      },
    },
    blendSlider('grow', ' px', v => (opts.grow = v)),
    blendSlider('feather', ' px', v => (opts.feather = v)),
    blendSlider('detail-seam', ' px', v => (opts.detailSeam = v)),
    blendSlider('global-match', '%', v => (opts.globalMatch = v / 100)),
    blendSlider('local-match', '%', v => (opts.localMatch = v / 100)),
    blendSlider('local-radius', ' px', v => (opts.localRadius = v)),
    blendSlider('tolerance', '%', v => (opts.tolerance = v / 100)),
    blendSlider('detail-match', '%', v => (opts.detailMatch = v / 100)),
    {
      id: 'offset-x',
      format: v => `${v.toFixed(1)} px`,
      apply: v => {
        offset.dx = v
        scheduleOffset()
      },
    },
    {
      id: 'offset-y',
      format: v => `${v.toFixed(1)} px`,
      apply: v => {
        offset.dy = v
        scheduleOffset()
      },
    },
  ]

  const radios: RadioDef[] = [
    {
      name: 'brush-mode',
      persist: true,
      apply: value => {
        editor.erase = value === 'erase'
        editor.updateCursorSize()
      },
    },
    { name: 'view', apply: value => setView(value as View) },
    {
      name: 'overlay',
      apply: value => {
        overlay = value as Overlay
        applyOverlay()
      },
    },
  ]

  function setSlider(s: SliderDef, v: number) {
    const input = $(s.id) as HTMLInputElement
    input.value = String(v)
    // The input clamps/snaps to its range and step; apply what it actually holds.
    const actual = +input.value
    const valueEl = $(`${s.id}-value`)
    if (valueEl) valueEl.textContent = s.format(actual)
    s.apply(actual)
  }

  const sliderById = (id: string) => sliders.find(s => s.id === id)!

  // --- Config save / load ---

  function collectSettings(): MaskSettings {
    const out: MaskSettings = {}
    for (const s of sliders) out[s.id] = +($(s.id) as HTMLInputElement).value
    for (const r of radios) if (r.persist) out[r.name] = radioValue(r.name)
    return out
  }

  function applySettings(settings: MaskSettings) {
    for (const s of sliders) {
      const v = settings[s.id]
      if (typeof v === 'number') setSlider(s, v)
    }
    for (const r of radios) {
      const v = settings[r.name]
      if (r.persist && typeof v === 'string') {
        setRadio(r.name, v)
        r.apply(v)
      }
    }
  }

  async function loadConfigFile(file: File) {
    try {
      applySettings(await readConfigFile(file))
      clearError()
    } catch (err) {
      showError(`Could not load config: ${(err as Error).message}`)
    }
  }

  // --- Drag & drop ---

  window.addEventListener('dragenter', e => {
    if (!e.dataTransfer?.types.includes('Files')) return
    dragCounter++
    document.body.classList.add('dragging')
  })

  window.addEventListener('dragleave', e => {
    if (!e.dataTransfer?.types.includes('Files')) return
    dragCounter = Math.max(0, dragCounter - 1)
    if (dragCounter === 0) document.body.classList.remove('dragging')
  })

  window.addEventListener('dragover', e => e.preventDefault())

  // Accept a drop anywhere on the page; files are routed to slots by name.
  window.addEventListener('drop', e => {
    e.preventDefault()
    dragCounter = 0
    document.body.classList.remove('dragging')
    void handleFiles(e.dataTransfer?.files)
  })

  for (const slot of ['source', 'modified', 'mask'] as const) {
    const zone = $(`slot-${slot}`)
    const input = $(`slot-${slot}-input`) as HTMLInputElement
    zone.addEventListener('dragover', e => {
      e.preventDefault()
      zone.classList.add('drag-over')
    })
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'))
    zone.addEventListener('drop', e => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter = 0
      document.body.classList.remove('dragging')
      zone.classList.remove('drag-over')
      void handleFiles(e.dataTransfer?.files, slot)
    })
    input.addEventListener('change', () => {
      void handleFiles(input.files, slot)
      input.value = ''
    })
  }

  // --- Buttons ---

  $('btn-undo').addEventListener('click', () => editor.undo())
  $('btn-redo').addEventListener('click', () => editor.redo())
  $('btn-clear-mask').addEventListener('click', () => editor.clear())
  $('btn-download-mask').addEventListener('click', () => {
    if (!W) return
    canvasMask.toBlob(blob => blob && downloadBlob(blob, `${baseName}-mask.png`), 'image/png')
  })
  $('download-png').addEventListener('click', () => {
    if (!W) return
    const canvas = hasResult ? canvasResult : canvasSource
    canvas.toBlob(blob => blob && downloadBlob(blob, `${baseName}-masked.png`), 'image/png')
  })
  $('btn-zoom-fit').addEventListener('click', () => editor.fit())
  $('btn-zoom-1').addEventListener('click', () => editor.zoomTo(1))
  compareBtn.addEventListener('click', toggleCompare)

  $('btn-auto-align').addEventListener('click', () => {
    if (!sourceData || !modifiedBase) return
    setStatus('aligning…')
    // Let the status paint before the (synchronous) search.
    setTimeout(() => {
      const o = estimateOffset(sourceData!, modifiedBase!, W, H, editor.getMask())
      setSlider(sliderById('offset-x'), o.dx)
      setSlider(sliderById('offset-y'), o.dy)
    }, 0)
  })

  $('btn-save-config').addEventListener('click', () => downloadConfig(`${baseName}.mask.json`, collectSettings()))
  const configFileInput = $('config-file-input') as HTMLInputElement
  $('btn-load-config').addEventListener('click', () => configFileInput.click())
  configFileInput.addEventListener('change', () => {
    const file = configFileInput.files?.[0]
    if (file) void loadConfigFile(file)
    configFileInput.value = ''
  })

  // --- Keys ---

  window.addEventListener('keydown', e => {
    if (!W || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return
    const key = e.key.toLowerCase()
    const brush = sliderById('brush-size')
    if (key === 'c') toggleCompare()
    else if (key === 'f') editor.fit()
    else if (key === '1') editor.zoomTo(1)
    else if (key === 'x') {
      const mode = radioValue('brush-mode') === 'erase' ? 'paint' : 'erase'
      setRadio('brush-mode', mode)
      radios.find(r => r.name === 'brush-mode')!.apply(mode)
    } else if (key === '[') setSlider(brush, Math.max(1, Math.round(editor.brushSize * 0.8)))
    else if (key === ']') setSlider(brush, Math.max(editor.brushSize + 1, Math.round(editor.brushSize * 1.25)))
    else return
    e.preventDefault()
  })

  // --- Wire controls ---

  for (const s of sliders) {
    const input = $(s.id) as HTMLInputElement
    const valueEl = $(`${s.id}-value`)
    input.addEventListener('input', () => {
      const v = +input.value
      if (valueEl) valueEl.textContent = s.format(v)
      s.apply(v)
    })
    // Adopt whatever the inputs hold (defaults, or values the browser restored).
    const v = +input.value
    if (valueEl) valueEl.textContent = s.format(v)
    s.apply(v)
  }

  for (const r of radios) {
    for (const el of document.querySelectorAll<HTMLInputElement>(`input[name="${r.name}"]`)) {
      el.addEventListener('change', () => {
        if (el.checked) r.apply(el.value)
      })
    }
    r.apply(radioValue(r.name))
  }
}
