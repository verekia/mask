// The painting viewport: a zoom/pan view over the stacked full-resolution canvases, and a
// brush that paints the mask (red, alpha = coverage) onto its own canvas in source pixels.
//
// Left-drag paints (Alt or Erase mode erases), right/middle-drag or Space-drag pans,
// ⌘/Ctrl+scroll or pinch zooms around the cursor, plain scroll pans.

const MAX_UNDO = 40
const MIN_ZOOM = 0.05
const MAX_ZOOM = 32

/** True when a key event belongs to a text field (sliders and radios don't count). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.tagName === 'TEXTAREA') return true
  return target.tagName === 'INPUT' && !['range', 'radio', 'checkbox'].includes((target as HTMLInputElement).type)
}

export interface EditorElements {
  viewport: HTMLElement
  content: HTMLElement
  maskCanvas: HTMLCanvasElement
  cursor: HTMLElement
}

export interface EditorCallbacks {
  /** A stroke, clear, undo/redo or import changed the mask. */
  onMaskChange: () => void
  onZoomChange: (zoom: number) => void
}

export class Editor {
  brushSize = 40
  erase = false

  private width = 0
  private height = 0
  private zoom = 1
  private panX = 0
  private panY = 0
  /** True until the user zooms or pans — the view then follows viewport resizes. */
  private fitted = true
  private spaceHeld = false
  private mode: 'idle' | 'paint' | 'pan' = 'idle'
  private last = { x: 0, y: 0 }
  private strokeErases = false
  private undoStack: Uint8Array[] = []
  private redoStack: Uint8Array[] = []
  private readonly ctx: CanvasRenderingContext2D

  constructor(
    private readonly el: EditorElements,
    private readonly cb: EditorCallbacks,
  ) {
    this.ctx = el.maskCanvas.getContext('2d', { willReadFrequently: true })!
    this.bindPointer()
    this.bindKeys()
    new ResizeObserver(() => {
      if (this.fitted) this.fit()
    }).observe(el.viewport)
  }

  /** Size the mask to the source; clears it when the dimensions change. */
  setImageSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return
    this.width = width
    this.height = height
    this.el.maskCanvas.width = width
    this.el.maskCanvas.height = height
    this.el.content.style.width = `${width}px`
    this.el.content.style.height = `${height}px`
    this.undoStack = []
    this.redoStack = []
    this.fit()
  }

  /** Mask coverage per pixel (0..255). */
  getMask(): Uint8Array {
    const data = this.ctx.getImageData(0, 0, this.width, this.height).data
    const out = new Uint8Array(this.width * this.height)
    for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + 3]
    return out
  }

  /** Replace the whole mask (undoable). */
  setMask(alpha: Uint8Array): void {
    this.pushUndo()
    this.putMask(alpha)
    this.cb.onMaskChange()
  }

  clear(): void {
    this.pushUndo()
    this.ctx.clearRect(0, 0, this.width, this.height)
    this.cb.onMaskChange()
  }

  undo(): void {
    const prev = this.undoStack.pop()
    if (!prev) return
    this.redoStack.push(this.getMask())
    this.putMask(prev)
    this.cb.onMaskChange()
  }

  redo(): void {
    const next = this.redoStack.pop()
    if (!next) return
    this.undoStack.push(this.getMask())
    this.putMask(next)
    this.cb.onMaskChange()
  }

  fit(): void {
    if (!this.width) return
    const vw = this.el.viewport.clientWidth
    const vh = this.el.viewport.clientHeight
    const z = Math.min(vw / this.width, vh / this.height)
    this.setView(z, (vw - this.width * z) / 2, (vh - this.height * z) / 2)
    this.fitted = true
  }

  /** Zoom to an absolute factor around the viewport center. */
  zoomTo(z: number): void {
    const vw = this.el.viewport.clientWidth
    const vh = this.el.viewport.clientHeight
    this.zoomAround(z, vw / 2, vh / 2)
  }

  private zoomAround(z: number, cx: number, cy: number): void {
    const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
    const ix = (cx - this.panX) / this.zoom
    const iy = (cy - this.panY) / this.zoom
    this.setView(nz, cx - ix * nz, cy - iy * nz)
    this.fitted = false
  }

  private setView(zoom: number, panX: number, panY: number): void {
    this.zoom = zoom
    this.panX = panX
    this.panY = panY
    this.el.content.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`
    // Show real pixels when inspecting up close.
    this.el.content.classList.toggle('pixelated', zoom >= 2)
    this.updateCursorSize()
    this.cb.onZoomChange(zoom)
  }

  private putMask(alpha: Uint8Array): void {
    const img = new ImageData(this.width, this.height)
    for (let i = 0; i < alpha.length; i++) {
      img.data[i * 4] = 255
      img.data[i * 4 + 3] = alpha[i]
    }
    this.ctx.putImageData(img, 0, 0)
  }

  private pushUndo(): void {
    this.undoStack.push(this.getMask())
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift()
    this.redoStack = []
  }

  // --- Pointer ---

  private toImage(e: PointerEvent | WheelEvent): { x: number; y: number; vx: number; vy: number } {
    const r = this.el.viewport.getBoundingClientRect()
    const vx = e.clientX - r.left
    const vy = e.clientY - r.top
    return { x: (vx - this.panX) / this.zoom, y: (vy - this.panY) / this.zoom, vx, vy }
  }

  private dab(x0: number, y0: number, x1: number, y1: number): void {
    const ctx = this.ctx
    ctx.save()
    ctx.globalCompositeOperation = this.strokeErases ? 'destination-out' : 'source-over'
    ctx.strokeStyle = '#ff0000'
    ctx.fillStyle = '#ff0000'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = this.brushSize
    if (x0 === x1 && y0 === y1) {
      ctx.beginPath()
      ctx.arc(x0, y0, this.brushSize / 2, 0, Math.PI * 2)
      ctx.fill()
    } else {
      ctx.beginPath()
      ctx.moveTo(x0, y0)
      ctx.lineTo(x1, y1)
      ctx.stroke()
    }
    ctx.restore()
  }

  private bindPointer(): void {
    const vp = this.el.viewport
    vp.addEventListener('contextmenu', e => e.preventDefault())

    vp.addEventListener('pointerdown', e => {
      if (!this.width || this.mode !== 'idle') return
      vp.setPointerCapture(e.pointerId)
      const p = this.toImage(e)
      if (e.button === 1 || e.button === 2 || (e.button === 0 && this.spaceHeld)) {
        this.mode = 'pan'
        this.last = { x: p.vx, y: p.vy }
        vp.classList.add('panning')
      } else if (e.button === 0) {
        this.mode = 'paint'
        // Shows the paint layer during the stroke even when the overlay is set elsewhere.
        vp.classList.add('painting')
        this.strokeErases = this.erase !== e.altKey
        this.pushUndo()
        this.last = { x: p.x, y: p.y }
        this.dab(p.x, p.y, p.x, p.y)
      }
    })

    vp.addEventListener('pointermove', e => {
      const p = this.toImage(e)
      this.moveCursor(p.vx, p.vy)
      if (this.mode === 'pan') {
        this.setView(this.zoom, this.panX + p.vx - this.last.x, this.panY + p.vy - this.last.y)
        this.fitted = false
        this.last = { x: p.vx, y: p.vy }
      } else if (this.mode === 'paint') {
        // Coalesced events keep fast strokes smooth (the list is empty for synthetic events).
        const coalesced = e.getCoalescedEvents?.() ?? []
        for (const ce of coalesced.length > 0 ? coalesced : [e]) {
          const q = this.toImage(ce)
          this.dab(this.last.x, this.last.y, q.x, q.y)
          this.last = { x: q.x, y: q.y }
        }
      }
    })

    const end = (e: PointerEvent) => {
      if (this.mode === 'idle') return
      if (vp.hasPointerCapture(e.pointerId)) vp.releasePointerCapture(e.pointerId)
      const painted = this.mode === 'paint'
      this.mode = 'idle'
      vp.classList.remove('panning', 'painting')
      if (painted) this.cb.onMaskChange()
    }
    vp.addEventListener('pointerup', end)
    vp.addEventListener('pointercancel', end)
    vp.addEventListener('pointerenter', () => this.el.cursor.classList.remove('hidden'))
    vp.addEventListener('pointerleave', () => this.el.cursor.classList.add('hidden'))

    vp.addEventListener(
      'wheel',
      e => {
        e.preventDefault()
        const p = this.toImage(e)
        if (e.ctrlKey || e.metaKey || e.altKey) {
          // Pinch arrives as ctrl+wheel with small deltas; a mouse wheel notch is ~100.
          this.zoomAround(this.zoom * Math.exp(-e.deltaY * 0.0025), p.vx, p.vy)
        } else {
          const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX
          const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY
          this.setView(this.zoom, this.panX - dx, this.panY - dy)
          this.fitted = false
        }
      },
      { passive: false },
    )
  }

  private moveCursor(vx: number, vy: number): void {
    this.el.cursor.style.transform = `translate(${vx}px, ${vy}px) translate(-50%, -50%)`
  }

  updateCursorSize(): void {
    const d = Math.max(4, this.brushSize * this.zoom)
    this.el.cursor.style.width = `${d}px`
    this.el.cursor.style.height = `${d}px`
    this.el.cursor.classList.toggle('erasing', this.erase)
  }

  // --- Keys ---

  private bindKeys(): void {
    window.addEventListener('keydown', e => {
      if (!this.width || isTypingTarget(e.target)) return
      if (e.code === 'Space') {
        if (!this.spaceHeld) this.el.viewport.classList.add('pan-ready')
        this.spaceHeld = true
        if (e.target === document.body || this.el.viewport.contains(e.target as Node)) e.preventDefault()
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) this.redo()
        else this.undo()
      }
    })
    window.addEventListener('keyup', e => {
      if (e.code === 'Space') {
        this.spaceHeld = false
        this.el.viewport.classList.remove('pan-ready')
      }
    })
  }
}
