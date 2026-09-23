import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

type CapturedPdfInput = {
  bodyHtml: string
  paperSize: string
  orientation: string
  marginMm: number
  headerHtml?: string | null
  footerHtml?: string | null
}

const state = { input: null as CapturedPdfInput | null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[
  Symbol.for('openbooks.pdf-render-sanitization-test')
] = state

function readCapturedInput(): CapturedPdfInput {
  // The test double mutates this value from a separate module, so TypeScript's
  // local control-flow analysis cannot observe that mutation.
  const input = state.input as CapturedPdfInput | null
  if (!input) throw new Error('renderHtmlDocumentPdf was not called')
  return input
}

const templateUrl = pathToFileURL(
  `${process.cwd()}/packages/pdf/src/template.ts`,
).href
// Absolute file URL of the real @openbooks/pdf surface, interpolated into the
// mock below. A bare or relative specifier cannot be used there: the mock
// module's base is the opaque `mock:` URL, so only an absolute URL reaches
// the real file without being re-intercepted by these same hooks.
const pdfIndexUrl = pathToFileURL(
  `${process.cwd()}/packages/pdf/src/index.ts`,
).href

registerHooks({
  resolve(specifier, _context, nextResolve) {
    if (specifier === 'server-only') return { url: 'mock:server-only', shortCircuit: true }
    if (specifier === '@openbooks/pdf') return { url: 'mock:openbooks-pdf', shortCircuit: true }
    return nextResolve(specifier, _context)
  },
  load(url, _context, nextLoad) {
    if (url === 'mock:server-only') return { format: 'module', source: 'export {}', shortCircuit: true }
    if (url === 'mock:openbooks-pdf') {
      return {
        format: 'module',
        // Thin re-export-plus-override of the real @openbooks/pdf surface: a
        // future export added to the package rides the star instead of
        // breaking this double's link. Importing the real index never
        // launches Chromium.
        source: `
          export * from ${JSON.stringify(pdfIndexUrl)}
          export { RendererUnavailableError } from ${JSON.stringify(pdfIndexUrl)}
          import { renderTemplate, sanitizeRenderedHtml, sanitizeTokenizedFragment } from ${JSON.stringify(templateUrl)}
          const state = globalThis[Symbol.for('openbooks.pdf-render-sanitization-test')]
          export { renderTemplate, sanitizeRenderedHtml, sanitizeTokenizedFragment }
          export function renderHtmlDocumentPdf(input) {
            state.input = input
            return Promise.resolve(Buffer.from('%PDF-1.4 test'))
          }
        `,
        shortCircuit: true,
      }
    }
    return nextLoad(url, _context)
  },
})

const renderModuleUrl = './render.ts?body-sanitization-test'
const { mergeAndPrintPdf } = (await import(renderModuleUrl)) as typeof import('./render')

test('the live PDF body path cannot emit triple-brace record markup', async () => {
  state.input = null
  const pdf = await mergeAndPrintPdf(
    {
      compiledHtml: '<p>{{name}}</p><p>{{{memo}}}</p>',
      paperSize: 'letter',
      orientation: 'portrait',
      marginMm: 14,
      headerHtml: null,
      footerHtml: null,
    },
    {
      name: 'Ada & Co',
      memo: '<img src="https://attacker.example/pixel" onerror="steal()">Visible note',
    },
  )

  assert.equal(pdf.toString(), '%PDF-1.4 test')
  // Delta (safer output): the merged body is sanitized again after merging,
  // so Chromium receives a whole-document body. Escaped record text passes
  // through byte-identical; only the document wrapper is added.
  assert.deepEqual(state.input, {
    bodyHtml: '<html><head></head><body><p>Ada &amp; Co</p><p>Visible note</p></body></html>',
    paperSize: 'letter',
    orientation: 'portrait',
    marginMm: 14,
    headerHtml: null,
    footerHtml: null,
  })
  const captured = readCapturedInput()
  assert.doesNotMatch(captured.bodyHtml, /attacker\.example|<img/i)
})

test('header and footer escape record values while keeping the live page counters raw', async () => {
  state.input = null
  await mergeAndPrintPdf(
    {
      compiledHtml: '<p>{{name}}</p>',
      paperSize: 'letter',
      orientation: 'portrait',
      marginMm: 14,
      headerHtml: '<div>{{name}} · {{{memo}}}</div>',
      footerHtml: '<div>Page {{page}} of {{pages}} — {{memo}}</div>',
    },
    {
      name: 'Ada & Co',
      // Entity-encoded markup: plainValue() decodes it to a real <img> tag, so
      // an unescaped header/footer merge would hand Chromium live markup.
      memo: '&lt;img src="https://attacker.example/pixel" onerror="steal()"&gt;Visible note',
    },
  )

  const captured = readCapturedInput()
  // Chrome sanitization re-serializes text quotes; the img stays escaped text.
  assert.equal(captured.headerHtml, '<div>Ada &amp; Co · &lt;img src="https://attacker.example/pixel" onerror="steal()"&gt;Visible note</div>')
  assert.equal(captured.footerHtml, '<div>Page {{page}} of {{pages}} — &lt;img src="https://attacker.example/pixel" onerror="steal()"&gt;Visible note</div>')
  assert.doesNotMatch(String(captured.headerHtml), /<img/i)
  assert.doesNotMatch(String(captured.footerHtml), /<img/i)
})

test('header and footer chrome cannot pass network resource URLs to the printer', async () => {
  state.input = null
  await mergeAndPrintPdf(
    {
      compiledHtml: '<p>x</p>',
      paperSize: 'letter',
      orientation: 'portrait',
      marginMm: 14,
      headerHtml: '<img src="https://static.example/logo.png" alt="mark">{{org}}',
      footerHtml: '<link rel="stylesheet" href="https://static.example/sheet.css">Page {{page}}',
    },
    { org: 'Acme' },
  )
  const captured = readCapturedInput()
  assert.match(String(captured.headerHtml), /Acme/)
  assert.match(String(captured.footerHtml), /\{\{page\}\}/)
  assert.doesNotMatch(String(captured.headerHtml), /static\.example|https?:\/\//i)
  assert.doesNotMatch(String(captured.footerHtml), /static\.example|https?:\/\//i)
})

test('a record value cannot set an attribute scheme in the printed body', async () => {
  state.input = null
  await mergeAndPrintPdf(
    {
      compiledHtml: '<p><a href="{{website}}">site</a></p><p><a href="{{pay_link}}">pay</a></p><p><img src="{{seal}}"></p>',
      paperSize: 'letter',
      orientation: 'portrait',
      marginMm: 14,
      headerHtml: null,
      footerHtml: null,
    },
    {
      // Save-time sanitization sees the inert `{{token}}` and keeps the
      // attribute; the scheme arrives only at merge time, so escaping (which
      // cannot touch `:`) lets it through — the post-merge sanitize is what
      // stops it reaching Chromium as a live link annotation.
      website: 'javascript:alert(1)',
      pay_link: 'https://example.com/pay',
      seal: 'data:image/png;base64,iVBORw0KGgo=',
    },
  )

  const captured = readCapturedInput()
  assert.equal(
    captured.bodyHtml,
    '<html><head></head><body><p><a>site</a></p><p><a href="https://example.com/pay">pay</a></p>' +
      '<p><img src="data:image/png;base64,iVBORw0KGgo="></p></body></html>',
  )
  assert.doesNotMatch(String(captured.bodyHtml), /javascript:/i)
})

test('a large legitimate merge is not refused at the authored size ceiling', async () => {
  state.input = null
  // 1.2MB of repeated safe rows: past the 1MB authored-template guard, well
  // under the 4MB rendered-output ceiling the print path enforces.
  const row = `<tr><td>${'A'.repeat(120)}</td></tr>`
  const compiledHtml = `<table><tbody>{{#each lines}}${row}{{/each}}</tbody></table>`
  const lines = Array.from({ length: 9500 }, (_, i) => ({ junk: `r${i}` }))
  await mergeAndPrintPdf(
    { compiledHtml, paperSize: 'letter', orientation: 'portrait', marginMm: 14, headerHtml: null, footerHtml: null },
    { lines },
  )
  const captured = readCapturedInput()
  assert.ok(String(captured.bodyHtml).length > 1_000_000)
  assert.ok(String(captured.bodyHtml).includes('<tr><td>AAAA'))
  assert.ok(String(captured.bodyHtml).includes('</tbody></table>'))
})

test('data:-document hrefs from record values are stripped; safe text survives', async () => {
  state.input = null
  await mergeAndPrintPdf(
    {
      compiledHtml: '<p><a href="{{doc}}">doc</a></p><div title="{{note}}">x</div>',
      paperSize: 'letter',
      orientation: 'portrait',
      marginMm: 14,
      headerHtml: null,
      footerHtml: null,
    },
    {
      doc: 'data:text/html,<script>alert(1)</script>',
      // Quote-breakout was already dead at merge time (`"` escapes); the
      // attribute stays inert text through the post-merge sanitize too.
      note: '" onmouseover="alert(1)',
    },
  )

  const captured = readCapturedInput()
  assert.equal(
    captured.bodyHtml,
    '<html><head></head><body><p><a>doc</a></p><div title="&quot; onmouseover=&quot;alert(1)">x</div></body></html>',
  )
  assert.doesNotMatch(String(captured.bodyHtml), /<script/i)
  assert.doesNotMatch(String(captured.bodyHtml), /onmouseover="alert/i)
})
