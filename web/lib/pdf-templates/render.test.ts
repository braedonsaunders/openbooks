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
        source: `
          import { renderTemplate } from ${JSON.stringify(templateUrl)}
          const state = globalThis[Symbol.for('openbooks.pdf-render-sanitization-test')]
          export { renderTemplate }
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
  assert.deepEqual(state.input, {
    bodyHtml: '<p>Ada &amp; Co</p><p>Visible note</p>',
    paperSize: 'letter',
    orientation: 'portrait',
    marginMm: 14,
    headerHtml: null,
    footerHtml: null,
  })
  const captured = readCapturedInput()
  assert.doesNotMatch(captured.bodyHtml, /attacker\.example|<img/i)
})
