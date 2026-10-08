import { useEffect } from 'react'
import Head from 'next/head'

type SliderProps = {
  id: string
  label: string
  min: number
  max: number
  step: number
  defaultValue: number
  display: string
  title?: string
}

const Slider = ({ id, label, min, max, step, defaultValue, display, title }: SliderProps) => (
  <label title={title}>
    <span className="control-label">{label}</span>
    <span className="control-value" id={`${id}-value`}>
      {display}
    </span>
    <input type="range" id={id} min={min} max={max} step={step} defaultValue={defaultValue} />
  </label>
)

type SlotProps = { slot: 'source' | 'modified' | 'mask'; label: string; hint: string; title: string }

const Slot = ({ slot, label, hint, title }: SlotProps) => (
  <div className="slot" title={title}>
    <span className="slot-label">{label}</span>
    <div id={`slot-${slot}`} className="drop-zone slot-zone" tabIndex={0}>
      <p id={`slot-${slot}-hint`}>{hint}</p>
      <canvas id={`slot-${slot}-thumb`} className="slot-thumb hidden"></canvas>
      <input type="file" id={`slot-${slot}-input`} className="file-input" accept="image/png,image/jpeg,image/webp" />
    </div>
  </div>
)

const DownloadArrow = () => (
  <svg className="dl-badge-arrow" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M8 2v9m0 0l-3.5-3.5M8 11l3.5-3.5M3 13h10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

export const MainView = () => {
  useEffect(() => {
    let cancelled = false
    void import('./main-init').then(m => {
      if (!cancelled) m.init()
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <>
      <Head>
        <title>MASK — Stabilize image-gen edits with a painted mask</title>
      </Head>
      <div id="app">
        <header id="app-header">
          <div className="header-bar">
            <div className="header-main">
              <h1>MASK — Stabilize image-gen edits with a painted mask</h1>
              <p className="intro">
                Drop a <b>source</b> image and a <b>modified</b>&nbsp;version of it: an image-gen edit that also drifted
                a little everywhere else. Paint over the source where changes are allowed: only those areas come from
                the modified image, color-matched to the source and blended in with an invisible seam. Everything else
                stays the exact source pixels, at the source&apos;s resolution. Settings save and restore as a{' '}
                <code>.mask.json</code>.
              </p>
              <div className="config-bar">
                <button
                  id="btn-save-config"
                  className="text-btn"
                  type="button"
                  title="Save all settings as a .mask.json"
                >
                  Save config
                </button>
                <button id="btn-load-config" className="text-btn" type="button" title="Load a .mask.json config">
                  Load config
                </button>
                <input type="file" id="config-file-input" className="offscreen-input" accept="application/json,.json" />
                <a
                  className="text-btn"
                  href="https://github.com/verekia/mask/"
                  target="_blank"
                  rel="noopener noreferrer"
                  title="View the source on GitHub"
                >
                  GitHub ↗
                </a>
              </div>
            </div>
            <div className="header-textures">
              <Slot
                slot="source"
                label="Source"
                hint="Drop the source image"
                title="The reference image. The result keeps its resolution and every pixel outside the mask."
              />
              <Slot
                slot="modified"
                label="Modified"
                hint="Drop the modified image"
                title="The edited image. Resized to the source if its size differs."
              />
              <Slot
                slot="mask"
                label="Mask"
                hint="Paint it below, or drop one"
                title="Optional mask image: alpha (or anything that differs from its background color) marks the areas allowed to change."
              />
            </div>
          </div>
          <div id="error-message" className="hidden"></div>
        </header>

        <section id="section-editor" className="stage hidden">
          <div className="stage-controls">
            <div className="control-group">
              <span className="control-group-title">Brush</span>
              <Slider
                id="brush-size"
                label="Size"
                min={1}
                max={400}
                step={1}
                defaultValue={40}
                display="40 px"
                title="Brush diameter in source pixels. [ and ] resize it."
              />
              <div className="radio-group seg" role="radiogroup" aria-label="Brush mode">
                <label title="Paint the areas allowed to change.">
                  <input type="radio" name="brush-mode" value="paint" defaultChecked /> Paint
                </label>
                <label title="Erase from the mask. Alt-drag also erases; X swaps modes.">
                  <input type="radio" name="brush-mode" value="erase" /> Erase
                </label>
              </div>
              <div className="button-row">
                <button id="btn-undo" className="text-btn" type="button" title="Undo (⌘/Ctrl+Z)">
                  Undo
                </button>
                <button id="btn-redo" className="text-btn" type="button" title="Redo (⌘/Ctrl+Shift+Z)">
                  Redo
                </button>
                <button id="btn-clear-mask" className="text-btn" type="button" title="Erase the whole mask">
                  Clear
                </button>
                <button id="btn-download-mask" className="text-btn" type="button" title="Download the mask as a PNG">
                  Save mask
                </button>
              </div>
            </div>

            <div className="control-group">
              <span className="control-group-title">Edge</span>
              <Slider
                id="grow"
                label="Grow"
                min={-32}
                max={64}
                step={1}
                defaultValue={4}
                display="4 px"
                title="Dilate (+) or erode (−) the painted mask. The grown mask is the hard limit: nothing outside it ever changes."
              />
              <Slider
                id="feather"
                label="Feather"
                min={1}
                max={128}
                step={1}
                defaultValue={24}
                display="24 px"
                title="Width of the soft transition, placed inside the grown edge. It narrows automatically on thin strokes so they still reach full strength."
              />
              <Slider
                id="detail-seam"
                label="Detail seam"
                min={1}
                max={128}
                step={1}
                defaultValue={3}
                display="3 px"
                title="Width over which fine detail switches from source to modified, while broad tone still fades over the whole feather (multi-band blending). Small avoids ghosted double edges where the two images don't line up; ≥ Feather is a plain cross-fade."
              />
            </div>

            <div className="control-group">
              <span className="control-group-title">Color</span>
              <Slider
                id="global-match"
                label="Global match"
                min={0}
                max={100}
                step={1}
                defaultValue={100}
                display="100%"
                title="Fit the modified image's overall color profile (white balance, saturation, levels) to the source — a robust 3×4 color transform estimated outside the mask."
              />
              <Slider
                id="local-match"
                label="Local match"
                min={0}
                max={100}
                step={1}
                defaultValue={100}
                display="100%"
                title="Correct the remaining local tone drift: the source − modified difference around the mask is smoothed and stretched across the patch (Poisson-style membrane), so the patch meets its surroundings seamlessly."
              />
              <Slider
                id="local-radius"
                label="Local radius"
                min={1}
                max={100}
                step={1}
                defaultValue={12}
                display="12 px"
                title="Smoothing of the local tone field. Small follows fine tone variations along the edge; large is calmer and ignores more edge jitter."
              />
              <Slider
                id="tolerance"
                label="Tolerance"
                min={1}
                max={50}
                step={1}
                defaultValue={8}
                display="8%"
                title="Differences larger than this count as content changes rather than tone drift, and are ignored when matching colors."
              />
            </div>

            <div className="control-group">
              <span className="control-group-title">Detail</span>
              <Slider
                id="detail-match"
                label="Detail match"
                min={0}
                max={100}
                step={1}
                defaultValue={0}
                display="0%"
                title="Match the modified image's fine-detail energy (sharpness, grain) to the source's around the mask. Helps when the modified image came out softer or noisier."
              />
            </div>

            <div className="control-group">
              <div className="control-group-head">
                <span className="control-group-title">Align</span>
                <button
                  id="btn-auto-align"
                  className="group-toggle"
                  type="button"
                  title="Estimate the translation between the two images (ignoring the painted areas)."
                >
                  Auto
                </button>
              </div>
              <Slider
                id="offset-x"
                label="Offset X"
                min={-64}
                max={64}
                step={0.1}
                defaultValue={0}
                display="0.0 px"
                title="Shift the modified image horizontally to line it up with the source."
              />
              <Slider
                id="offset-y"
                label="Offset Y"
                min={-64}
                max={64}
                step={0.1}
                defaultValue={0}
                display="0.0 px"
                title="Shift the modified image vertically to line it up with the source."
              />
            </div>
          </div>

          <div className="stage-preview">
            <div className="stage-preview-inner">
              <div className="toolbar">
                <button
                  id="btn-compare"
                  className="compare-btn"
                  type="button"
                  aria-pressed="true"
                  title="Flip between the result and the source on top of each other (C)"
                >
                  Result
                </button>
                <div className="radio-group seg" role="radiogroup" aria-label="View">
                  <label title="The blended result.">
                    <input type="radio" name="view" value="result" defaultChecked /> Result
                  </label>
                  <label title="The untouched source.">
                    <input type="radio" name="view" value="source" /> Source
                  </label>
                  <label title="The modified image (aligned to the source).">
                    <input type="radio" name="view" value="modified" /> Modified
                  </label>
                </div>
                <div className="toolbar-group">
                  <span className="toolbar-label">Mask</span>
                  <div className="radio-group seg" role="radiogroup" aria-label="Mask overlay">
                    <label title="Hide the mask overlay.">
                      <input type="radio" name="overlay" value="off" /> Off
                    </label>
                    <label title="Show the painted strokes.">
                      <input type="radio" name="overlay" value="paint" defaultChecked /> Paint
                    </label>
                    <label title="Show the effective blend weight after grow and feather.">
                      <input type="radio" name="overlay" value="blend" /> Blend
                    </label>
                  </div>
                </div>
                <div className="toolbar-group toolbar-end">
                  <button id="btn-zoom-fit" className="text-btn" type="button" title="Fit the image (F)">
                    Fit
                  </button>
                  <button id="btn-zoom-1" className="text-btn" type="button" title="Actual pixels (1)">
                    1:1
                  </button>
                  <span id="zoom-value" className="toolbar-label zoom-value">
                    100%
                  </span>
                  <button id="download-png" className="text-btn" type="button" title="Download the result as a PNG">
                    <DownloadArrow /> PNG
                  </button>
                </div>
              </div>
              <div id="viewport" className="viewport">
                <div id="viewport-content" className="viewport-content">
                  <canvas id="canvas-source"></canvas>
                  <canvas id="canvas-modified" className="hidden"></canvas>
                  <canvas id="canvas-result"></canvas>
                  <canvas id="canvas-coverage" className="mask-layer hidden"></canvas>
                  <canvas id="canvas-mask" className="mask-layer"></canvas>
                </div>
                <div id="brush-cursor" className="brush-cursor hidden"></div>
                <div id="view-badge" className="view-badge">
                  Result
                </div>
              </div>
              <div className="status-row">
                <span id="status" className="status"></span>
                <span className="status hint">
                  Drag paints · Alt-drag erases · Space/right-drag pans · ⌘/Ctrl+scroll zooms · [ ] brush · C compare
                </span>
              </div>
            </div>
          </div>
        </section>
      </div>
    </>
  )
}
