/** Code 128 symbol patterns, values 0–105, followed by the stop pattern. */
const CODE128_PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232',
] as const

const CODE128_STOP_PATTERN = '2331112'
const CODE128_STOP = 106
const CODE128_START_B = 104
const CODE128_START_C = 105
const CODE128_CODE_B = 100
const CODE128_CODE_C = 99

export const CODE128_MODULE_WIDTH_MM = 0.25
export const CODE128_QUIET_ZONE_MODULES = 10
export const CODE128_BAR_HEIGHT_MM = 25
const HUMAN_READABLE_HEIGHT_MM = 4

export type Code128Encoding = {
  /** Start, data and code-set symbols, checksum, then stop (106). */
  codewords: number[]
  /** Published narrow/wide run widths, one string per symbol. */
  patterns: string[]
}

function digitRunLength(value: string, at: number): number {
  let end = at
  while (end < value.length && value.charCodeAt(end) >= 48 && value.charCodeAt(end) <= 57) end += 1
  return end - at
}

function patternFor(codeword: number): string {
  return codeword === CODE128_STOP ? CODE128_STOP_PATTERN : CODE128_PATTERNS[codeword]!
}

/** Encode printable ASCII as Code 128, switching between subsets B and C. */
export function encodeCode128(value: string): Code128Encoding {
  if (value.length === 0) throw new Error('Code 128 requires a non-empty value.')
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 32 || code > 126) {
      throw new Error('Code 128 subset B/C accepts printable ASCII only.')
    }
  }

  const firstRun = digitRunLength(value, 0)
  let codeSet: 'B' | 'C' = firstRun >= 4 && firstRun % 2 === 0 ? 'C' : 'B'
  const codewords: number[] = [codeSet === 'C' ? CODE128_START_C : CODE128_START_B]
  let at = 0

  while (at < value.length) {
    const run = digitRunLength(value, at)
    if (codeSet === 'B' && run >= 4) {
      // Code C consumes pairs. In an odd run, keep the leading digit in B.
      if (run % 2 === 1) {
        codewords.push(value.charCodeAt(at)! - 32)
        at += 1
      }
      codewords.push(CODE128_CODE_C)
      codeSet = 'C'
      continue
    }
    if (codeSet === 'C') {
      if (run >= 2) {
        codewords.push(Number(value.slice(at, at + 2)))
        at += 2
      } else {
        codewords.push(CODE128_CODE_B)
        codeSet = 'B'
      }
      continue
    }
    codewords.push(value.charCodeAt(at)! - 32)
    at += 1
  }

  let checksum = codewords[0]!
  for (let i = 1; i < codewords.length; i += 1) checksum += codewords[i]! * i
  codewords.push(checksum % 103, CODE128_STOP)
  return { codewords, patterns: codewords.map(patternFor) }
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  })[char]!)
}

/** Render a black-on-white Code 128 SVG with a fixed X-dimension and quiet zone. */
export function renderCode128Svg(value: string): string {
  if (!value) return ''
  const encoded = encodeCode128(value)
  const quietZone = CODE128_QUIET_ZONE_MODULES
  const moduleCount = encoded.patterns.reduce((total, pattern) =>
    total + [...pattern].reduce((width, run) => width + Number(run), 0), 0)
  const widthModules = moduleCount + quietZone * 2
  const widthMm = widthModules * CODE128_MODULE_WIDTH_MM
  const heightMm = CODE128_BAR_HEIGHT_MM + HUMAN_READABLE_HEIGHT_MM
  const label = escapeXml(value)
  let x = quietZone
  let isBar = true
  const bars: string[] = []
  for (const pattern of encoded.patterns) {
    for (const run of pattern) {
      const width = Number(run)
      if (isBar) bars.push(`<rect x="${x}" y="0" width="${width}" height="${CODE128_BAR_HEIGHT_MM}"/>`)
      x += width
      isBar = !isBar
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Code 128 ${label}" ` +
    `width="${widthMm}mm" height="${heightMm}mm" viewBox="0 0 ${widthModules} 29" ` +
    `shape-rendering="crispEdges" style="display:block;background:#fff;fill:#000">` +
    `<title>Code 128 ${label}</title>${bars.join('')}` +
    `<text x="${widthModules / 2}" y="28.5" text-anchor="middle" font-family="Arial,sans-serif" font-size="3">${label}</text></svg>`
}
