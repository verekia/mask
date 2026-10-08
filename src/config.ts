// Mask config: a flat snapshot of every control, saved next to an image pair so the
// full param set (edge / color / detail / align / brush) can be restored later. Values
// are plain numbers and strings keyed by control id, so the format stays
// forward-compatible: unknown keys are ignored on load and missing keys keep their
// current value.

export const MASK_CONFIG_VERSION = 1

export type MaskSettings = Record<string, number | string>

export function buildConfigJson(settings: MaskSettings): string {
  return `${JSON.stringify({ mask: MASK_CONFIG_VERSION, settings }, null, 2)}\n`
}

export function parseConfigJson(text: string): MaskSettings {
  const data: unknown = JSON.parse(text)
  if (!data || typeof data !== 'object') throw new Error('Not a Mask config file.')
  // Accept either the wrapped form ({ mask, settings }) or a bare settings object.
  const raw = 'settings' in data ? (data as { settings: unknown }).settings : data
  if (!raw || typeof raw !== 'object') throw new Error('No settings found in config.')

  const out: MaskSettings = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' || typeof value === 'string') out[key] = value
  }
  if (Object.keys(out).length === 0) throw new Error('Config has no recognizable settings.')
  return out
}

export function downloadConfig(filename: string, settings: MaskSettings): void {
  const blob = new Blob([buildConfigJson(settings)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function readConfigFile(file: File): Promise<MaskSettings> {
  return file.text().then(parseConfigJson)
}

export function isConfigFile(file: File): boolean {
  return file.type === 'application/json' || /\.json$/i.test(file.name)
}
