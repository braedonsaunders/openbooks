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

const { recruitingSpec } = await import('./view.ts')

/**
 * CK-32b sibling: /hrm/recruiting builds the same collapse as
 * /hrm/documents had — a bare register table (openings or depth) as a
 * shrinkable flex item (`flex h-full min-h-0 flex-col`) under a
 * viewport-locked page body, with setup-section siblings spread into
 * the SAME grid after it. Tall content collapses the table box to zero,
 * rows overflow visibly, and the setup sections paint over the row
 * links and steal their clicks. The register must be content-sized in
 * normal flow with the sections stacking after it. This drives
 * recruitingSpec (the emitted render tree), never the source text.
 */
function stubData(): Record<string, unknown> {
  const columns = {
    number: 'Number',
    title: 'Title',
    position: 'Position',
    department: 'Department',
    headcount: 'Headcount',
    hiringManager: 'Hiring manager',
    opened: 'Opened',
    status: 'Status',
  }
  return {
    title: 'Recruiting',
    description: 'Hiring pipeline',
    tabs: [],
    canManage: false,
    addLabel: 'New',
    addHref: '/hrm/recruiting?requisition=new',
    basePath: '/hrm/recruiting',
    segmentsLabel: 'Status',
    allLabel: 'All',
    segmentOptions: [],
    currentParams: {},
    columns,
    rows: [],
    empty: 'No openings',
    totalLabel: 'Total',
    totals: { headcount: '0', filled: '0' },
    tab: 'openings',
    depthTabs: [],
    viewTabs: [],
    statusLabel: 'Status',
    depthRows: null,
    depthColumns: null,
    depthEmpty: 'None',
    setupSections: ['kit-x'],
    drawerOpen: false,
    draftDrawer: null,
    draftDrawerOpen: false,
    drawer: null,
  }
}

type Block = { kind: string; className?: unknown; blocks?: Block[]; widget?: unknown; props?: Record<string, unknown> }

function specOf(): { body: Block[]; bodyClassName?: unknown } {
  return recruitingSpec(stubData() as never) as unknown as { body: Block[]; bodyClassName?: unknown }
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
  const grids = findBlocks(specOf().body, 'grid')
  const matches = grids.filter((grid) => findBlocks(grid.blocks ?? [], 'table').length > 0)
  assert.equal(matches.length, 1, 'the register table must live in exactly one grid')
  return matches[0]!
}

test('CK-32b: the recruiting body is not a viewport-locked flex column', () => {
  const className = String(specOf().bodyClassName ?? '')
  for (const clamp of ['h-full', 'h-screen', 'h-dvh', 'h-svh', 'max-h-', 'min-h-screen']) {
    assert.ok(!className.includes(clamp), `the page body must not lock to the viewport (${clamp} collapses the register under the sections)`)
  }
  assert.ok(!tokens(className).includes('flex-col'), 'the page body must stack sections in normal block flow, not as flex items')
})

test('CK-32b: the recruiting register sizes to content, never to the viewport', () => {
  const className = String(registerGrid().className ?? '')
  for (const clamp of ['h-full', 'h-screen', 'h-dvh', 'max-h-']) {
    assert.ok(!className.includes(clamp), `the register grid must not clamp height (${clamp} overflows rows under the sections)`)
  }
  const names = tokens(className)
  assert.ok(!names.includes('flex'), 'the register grid must not be a shrinkable flex item (it collapses under the sections)')
  assert.ok(!names.includes('min-h-0'), 'the register grid must not opt into shrinking below its content (min-h-0 overflows rows under the sections)')
})

test('CK-32b: recruiting setup sections stack after the register, never over it', () => {
  const parent = registerGrid()
  const kinds = (parent.blocks ?? []).map((block) =>
    block.kind === 'table'
      ? 'table'
      : block.kind === 'widget' && (block as { widget?: unknown }).widget === 'setup-section'
        ? 'setup-section'
        : block.kind,
  )
  const lastTable = kinds.lastIndexOf('table')
  const firstSection = kinds.indexOf('setup-section')
  assert.ok(lastTable >= 0, 'the register table must render in the grid')
  assert.ok(firstSection >= 0, 'the setup sections must render in the same flow')
  assert.ok(firstSection > lastTable, 'the setup sections must stack after the register, never over it')
})
