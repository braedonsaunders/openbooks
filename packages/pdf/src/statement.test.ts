import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import test from 'node:test'
import PDFDocument from 'pdfkit'
import { renderStatementPdf, type StatementPdfInput } from './statement'

/**
 * Visible text of a pdfkit statement, decoded from the content streams.
 * pdfkit encodes WinAnsi text as hex runs inside Tj/TJ shows; inflating the
 * streams and decoding those runs recovers what the reader sees, so tests
 * can assert on printed amounts without parsing PDF operators.
 */
function visibleText(pdf: Buffer): string {
  const raw = pdf.toString('latin1')
  const re = /stream\r?\n([\s\S]*?)endstream/g
  let out = ''
  let match: RegExpExecArray | null
  while ((match = re.exec(raw)) !== null) {
    let body = Buffer.from(match[1] ?? '', 'latin1')
    try {
      body = inflateSync(body)
    } catch {
      /* not a flated stream */
    }
    const text = body.toString('latin1')
    for (const hex of text.matchAll(/<([0-9A-Fa-f]+)>/g)) {
      try {
        out += Buffer.from(hex[1] ?? '', 'hex').toString('latin1')
      } catch {
        /* not a text run */
      }
    }
  }
  return out
}

const BASE: Omit<StatementPdfInput, 'columns' | 'rows'> = {
  companyName: 'Example Org',
  title: 'Balance Sheet',
  periodPhrase: 'Year ended 2026-12-31',
  locale: 'en-CA',
  currency: 'CAD',
  style: 'formal',
  branding: { orgName: 'Example Org' },
  page: { paperSize: 'letter', orientation: 'landscape', marginMm: 15, density: 'standard' },
  generatedAt: new Date('2026-01-01T00:00:00Z'),
}

type TextSpan = { page: number; x: number; y: number; text: string; font: string; size: number }

/**
 * Positioned text of a pdfkit statement: every BT…ET show with the Tm
 * position and Tf font/size in force, kerning adjustments dropped (they are
 * sub-point). Widths are re-measured below with a fresh PDFDocument, so the
 * overlap assertion below is an independent check of the layout, not a
 * restatement of it.
 */
function textSpans(pdf: Buffer): TextSpan[] {
  const raw = pdf.toString('latin1')
  const baseByObj = new Map<string, string>()
  for (const match of raw.matchAll(/(\d+) 0 obj(?:(?!endobj)[\s\S]{0,2000})\/BaseFont\s*\/([A-Za-z+-]+)/g)) {
    if (match[1] !== undefined && match[2] !== undefined) baseByObj.set(match[1], match[2])
  }
  const fontByRef = new Map<string, string>()
  for (const match of raw.matchAll(/\/F(\d+) (\d+) 0 R/g)) {
    const base = match[2] === undefined ? undefined : baseByObj.get(match[2])
    if (base && match[1] !== undefined) fontByRef.set(match[1], base)
  }
  const unescapeLiteral = (s: string): string =>
    s.replace(/\\([nrtbf()\\]|[\r\n]+|\d{1,3})/g, (full, code: string) => {
      if (code === 'n') return '\n'
      if (code === 'r') return '\r'
      if (code === 't') return '\t'
      if (code === 'b') return '\b'
      if (code === 'f') return '\f'
      if (/^\d+$/.test(code)) return String.fromCharCode(parseInt(code, 8))
      return code
    })
  const decodeShow = (arrayBody: string | undefined, literal: string | undefined): string => {
    let text = ''
    if (arrayBody !== undefined) {
      // One ordered pass: an array can mix hex and literal runs.
      for (const run of arrayBody.matchAll(/<([0-9A-Fa-f]+)>|\(((?:[^()\\]|\\.)*)\)/g)) {
        if (run[1] !== undefined) {
          try {
            text += Buffer.from(run[1], 'hex').toString('latin1')
          } catch {
            /* not a text run */
          }
        } else {
          text += unescapeLiteral(run[2] ?? '')
        }
      }
    } else {
      text += unescapeLiteral(literal ?? '')
    }
    return text
  }
  const pages: TextSpan[][] = []
  for (const streamMatch of raw.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    let body = Buffer.from(streamMatch[1] ?? '', 'latin1')
    try {
      body = inflateSync(body)
    } catch {
      /* not a flated stream */
    }
    const ops = body.toString('latin1')
    if (!ops.includes(' Tm')) continue
    const pageSpans: TextSpan[] = []
    let x = 0
    let y = 0
    let font = 'Times-Roman'
    let size = 10
    const token = /(1 0 0 1 ([\d.]+) ([\d.]+) Tm)|(\/F(\d+) ([\d.]+) Tf)|(\[((?:<[^>]*>|\((?:[^()\\]|\\.)*\)|-?\d+(?:\.\d+)?|\s)+)\] TJ)|\(((?:[^()\\]|\\.)*)\) Tj/g
    let match: RegExpExecArray | null
    while ((match = token.exec(ops)) !== null) {
      if (match[2] !== undefined) {
        x = Number(match[2])
        y = Number(match[3])
      } else if (match[5] !== undefined) {
        font = fontByRef.get(match[5]) ?? font
        size = Number(match[6])
      } else {
        const text = decodeShow(match[8], match[9])
        if (text) pageSpans.push({ page: pages.length, x, y, text, font, size })
      }
    }
    if (pageSpans.length > 0) pages.push(pageSpans)
  }
  return pages.flat()
}

/** Assert no two texts on one line overlap horizontally. */
function assertNoOverlap(spans: TextSpan[]): void {
  const measure = new PDFDocument({ size: [612, 792] })
  const bands = new Map<string, TextSpan[]>()
  for (const span of spans) {
    const key = `${span.page}:${Math.round(span.y)}`
    const band = bands.get(key) ?? []
    band.push(span)
    bands.set(key, band)
  }
  for (const [key, band] of bands) {
    if (band.length < 2) continue
    const measured = band.map((span) => {
      measure.font(span.font).fontSize(span.size)
      return { ...span, end: span.x + measure.widthOfString(span.text) }
    }).sort((a, b) => a.x - b.x)
    for (let i = 0; i + 1 < measured.length; i++) {
      const gap = measured[i + 1]!.x - measured[i]!.end
      assert.ok(
        gap >= -1,
        `line ${key} overlaps: ${JSON.stringify(measured[i]!.text)} ends at ${measured[i]!.end.toFixed(1)} but ${JSON.stringify(measured[i + 1]!.text)} starts at ${measured[i + 1]!.x.toFixed(1)}`,
      )
    }
  }
}

test('a leading percentage-only row does not steal the first amount row currency symbol', async () => {
  const pdf = await renderStatementPdf({
    ...BASE,
    columns: [
      { label: 'Balance', kind: 'amount' },
      { label: 'Change %', kind: 'variance_pct' },
    ],
    rows: [
      // A variance-only commentary row: no amount, so it must not count as
      // the first amount row.
      { kind: 'account', label: 'Opening note', values: [null, '5.0'] },
      { kind: 'account', label: 'Cash', values: ['200', null] },
    ],
  })
  const text = visibleText(pdf)
  assert.ok(text.includes('5.0%'), `expected the percentage to print, saw ${JSON.stringify(text)}`)
  assert.ok(text.includes('$200.00'), `expected the first amount with its symbol, saw ${JSON.stringify(text)}`)
})

const TWELVE_PERIODS: StatementPdfInput = {
  companyName: 'Example Org',
  title: 'Trial Balance',
  periodPhrase: 'FY2026',
  locale: 'en-CA',
  currency: 'CAD',
  columns: Array.from({ length: 12 }, (_, i) => ({ label: `Period ${i + 1}`, kind: 'amount' as const })),
  rows: [
    {
      kind: 'account',
      label: 'Cash and cash equivalents held in operating accounts',
      values: Array(12).fill('1234567.89'),
    },
    { kind: 'total', label: 'Total assets', values: Array(12).fill('1234567.89') },
  ],
  style: 'formal',
  branding: { orgName: 'Example Org' },
  page: { paperSize: 'letter', orientation: 'landscape', marginMm: 15, density: 'standard' },
  generatedAt: new Date('2026-01-01T00:00:00Z'),
  footnote: `Note: amounts are presented in Canadian dollars. ${'Rounding may cause totals to differ from the sum of components. '.repeat(20)}`,
}

test('twelve wide amount columns print without overlapping', async () => {
  // A typical formatted amount needs ~61 pt at body size but an equal split
  // offers ~41 pt: the old layout overran every column into its neighbour.
  const pdf = await renderStatementPdf(TWELVE_PERIODS)
  const spans = textSpans(pdf)
  const all = spans.map((span) => span.text).join('')
  for (let i = 1; i <= 12; i++) {
    assert.ok(all.includes(`Period ${i}`), `expected column header Period ${i} to print`)
  }
  assert.ok(all.includes('Total assets'), 'expected the total row to print')
  assertNoOverlap(spans)
})

test('a long footnote survives a many-column statement intact', async () => {
  const pdf = await renderStatementPdf(TWELVE_PERIODS)
  const all = textSpans(pdf)
    .map((span) => span.text)
    .join('')
  assert.ok(all.includes('amounts are presented in Canadian dollars'), 'expected the footnote head to print')
  assert.ok(
    all.includes('Rounding may cause totals to differ from the sum of components.'),
    'expected the footnote body to print',
  )
})

test('columns that cannot fit legibly are refused by name', async () => {
  const columns = Array.from({ length: 30 }, (_, i) => ({ label: `Period ${i + 1}`, kind: 'amount' as const }))
  await assert.rejects(
    () =>
      renderStatementPdf({
        ...TWELVE_PERIODS,
        columns,
        rows: [
          { kind: 'account', label: 'Cash', values: Array(30).fill('12345678901234567890.99') },
        ],
        page: { paperSize: 'letter', orientation: 'portrait', marginMm: 15, density: 'standard' },
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match((error as Error).message, /Too many columns \(30\)/)
      return true
    },
  )
})
