import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    }
    if (specifier === 'next-intl/server') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,' + encodeURIComponent('export async function getTranslations(){return (s)=>s;}'),
      }
    }
    return next(specifier, context)
  },
})

const { documentsSpec } = await import('./view.ts')
const appkit = await import('@braedonsaunders/appkit-viewspec')

/**
 * CK-32/CK-32b: the signed-document rows were visually overlapped by the
 * Document templates section — elementFromPoint at a row-link centre hit
 * the templates TH/TD. The first fix removed the register grid's own
 * h-full, but the served build still failed: the real compressor is the
 * PAGE-level viewport lock (bodyClassName `flex h-full min-h-0 flex-col`
 * on the scroll-content box). The register grid is a flex item with
 * min-h-0, so it shrinks below its content height whenever the stacked
 * sections exceed the viewport; its rows overflow visibly and the later
 * setup-section siblings paint over them and intercept clicks. The page
 * has no internal scroll panel (unlike the app-feel HRM tabs), so the
 * whole body must stack in normal block flow inside the page scroller.
 * This drives documentsSpec (the emitted render tree), never the source
 * text: it fails while the viewport lock or the shrinkable register
 * grid is present and passes without them.
 */
function stubData(): Record<string, unknown> {
  return {
    tabs: [],
    viewTabs: [],
    currentParams: {},
    segmentsLabel: 'Status',
    allLabel: 'All',
    segmentOptions: [],
    columns: { title: 'Title', person: 'Person', category: 'Category', sent: 'Sent', expires: 'Expires', status: 'Status' },
    drawer: null,
    generate: null,
  }
}

type Block = { kind: string; className?: unknown; blocks?: Block[]; widget?: unknown; props?: Record<string, unknown> }

function bodyBlocks(): Block[] {
  const spec = documentsSpec(stubData() as never) as { body: Block[] }
  return spec.body
}

function findBlocks(blocks: Block[], kind: string, out: Block[] = []): Block[] {
  for (const block of blocks) {
    if (block.kind === kind) out.push(block)
    if (Array.isArray(block.blocks)) findBlocks(block.blocks, kind, out)
  }
  return out
}

function tokens(className: unknown): string[] {
  return String(className ?? '').split(/\s+/).filter(Boolean)
}

function registerGrid(): Block {
  const grids = findBlocks(bodyBlocks(), 'grid')
  const registerGrids = grids.filter((grid) =>
    findBlocks(grid.blocks ?? [], 'table').length > 0,
  )
  assert.equal(registerGrids.length, 1, 'the register table must live in exactly one grid')
  return registerGrids[0]!
}

test('CK-32b: the page body is not a viewport-locked flex column', () => {
  const spec = documentsSpec(stubData() as never) as { bodyClassName?: unknown }
  const className = String(spec.bodyClassName ?? '')
  for (const clamp of ['h-full', 'h-screen', 'h-dvh', 'h-svh', 'max-h-', 'min-h-screen']) {
    assert.ok(!className.includes(clamp), `the page body must not lock to the viewport (${clamp} compresses the register under the sections)`)
  }
  const names = tokens(className)
  assert.ok(!names.includes('flex-col'), 'the page body must stack sections in normal block flow, not as flex items')
})

test('CK-32: the register grid sizes to content, never to the viewport', () => {
  const className = String(registerGrid().className ?? '')
  for (const clamp of ['h-full', 'h-screen', 'h-dvh', 'max-h-']) {
    assert.ok(!className.includes(clamp), `the register grid must not clamp height (${clamp} overflows rows under the sections)`)
  }
  const names = tokens(className)
  assert.ok(!names.includes('flex'), 'the register grid must not be a shrinkable flex item (it compresses under the sections)')
  assert.ok(!names.includes('min-h-0'), 'the register grid must not opt into shrinking below its content (min-h-0 overflows rows under the sections)')
})

test('CK-32: the templates section stacks after the register as a sibling', () => {
  const body = bodyBlocks()
  const registerIndex = body.findIndex(
    (block) => block.kind === 'grid' && findBlocks(block.blocks ?? [], 'table').length > 0,
  )
  const templatesIndex = body.findIndex(
    (block) =>
      block.kind === 'widget' &&
      (block as { widget?: unknown }).widget === 'setup-section' &&
      (block.props as { entityKey?: unknown } | undefined)?.entityKey === 'hrm-document-templates',
  )
  assert.ok(registerIndex >= 0, 'the register grid must be a top-level body block')
  assert.ok(templatesIndex >= 0, 'the templates section must be a top-level body block')
  assert.ok(templatesIndex > registerIndex, 'the templates section must stack after the register, never over it')
})

test('CK-32: no block positions itself out of flow', () => {
  const outOfFlow: string[] = []
  const walk = (blocks: Block[], path: string) => {
    for (const block of blocks) {
      for (const key of ['className', 'actionsClassName', 'bodyClassName'] as const) {
        const value = (block as Record<string, unknown>)[key]
        if (typeof value === 'string' && /(?:^|\s)(?:absolute|fixed)(?:\s|$)/.test(value)) {
          outOfFlow.push(`${path}/${block.kind}.${key}`)
        }
      }
      if (Array.isArray(block.blocks)) walk(block.blocks, `${path}/${block.kind}`)
    }
  }
  const spec = documentsSpec(stubData() as never) as { header: Block[]; body: Block[] }
  walk([...spec.header, ...spec.body], 'page')
  assert.deepEqual(outOfFlow, [], 'no block may take itself out of normal flow')
  assert.ok(typeof appkit.page === 'function', 'the spec composes the shared page builder')
})
