import assert from 'node:assert/strict'
import test from 'node:test'

const { bootJsdomEnvironment } = await import('../../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/admin/pdf-templates/019f68a5-6a24-78ec-bed6-cc04e06f2078', matchMediaMatches: false, resizeObserver: false })

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@grapesjs/react') {
      return { shortCircuit: true, format: 'module', url: 'mock:pdf-builder-gjs-react' }
    }
    if (specifier === 'grapesjs') {
      return { shortCircuit: true, format: 'module', url: 'mock:pdf-builder-grapesjs' }
    }
    if (specifier.endsWith('.css')) {
      return { shortCircuit: true, format: 'module', url: 'mock:pdf-builder-css' }
    }
    return next(specifier, context)
  },
  load(url, context, nextLoad) {
    // The editor shell is third-party code: stand in for it and capture the
    // options the builder boots it with — the only thing under test.
    if (url === 'mock:pdf-builder-gjs-react') {
      return {
        format: 'module',
        source: `
          export default function GjsEditor(props) {
            globalThis.__pdfBuilderOptions = props?.options
            return globalThis.React.createElement('div', { 'data-testid': 'gjs-editor' })
          }
          export function BlocksProvider({ children }) { return children ?? null }
          export function Canvas() { return null }
        `,
        shortCircuit: true,
      }
    }
    if (url === 'mock:pdf-builder-grapesjs') {
      return { format: 'module', source: 'export default {}', shortCircuit: true }
    }
    if (url === 'mock:pdf-builder-css') {
      return { format: 'module', source: 'export default {}', shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { default: PdfBuilder } = await import('./PdfBuilder')

/**
 * grapesjs injects its cssIcons default (font-awesome 4.7.0 on
 * cdnjs) unless disabled, and the app CSP blocks it on every editor load.
 * No template or block uses fa-* classes, so the builder pins cssIcons off
 * rather than vendoring a stylesheet nothing renders.
 */
test('the builder boots the canvas with icon fonts off and no CDN stylesheet', async () => {
  document.body.innerHTML = ''
  ;(globalThis as Record<string, unknown>).__pdfBuilderOptions = undefined
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      React.createElement(PdfBuilder, {
        initialHtml: '<p>hi</p>',
        pageWidthPx: 816,
        pageHeightPx: 1056,
        marginPx: 48,
        onReady: () => {},
        labels: { content: 'Content', fields: 'Fields', tables: 'Tables' },
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  try {
    const options = (globalThis as Record<string, unknown>).__pdfBuilderOptions as
      | Record<string, unknown>
      | undefined
    assert.ok(options, 'the builder must boot the editor with explicit options')
    assert.equal(options.cssIcons, '', 'grapesjs cssIcons must be explicitly disabled')
    assert.doesNotMatch(
      JSON.stringify(options),
      /cdnjs|font-awesome|fontawesome/i,
      'the editor options must reference no external CDN stylesheet',
    )
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})
