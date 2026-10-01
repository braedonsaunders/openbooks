const { stubModules } = await import('../../../../testing/stub-modules')
stubModules({ intl: 'export async function getTranslations(){return (s)=>s;}' })

import assert from 'node:assert/strict'
import test from 'node:test'

const { recruitingSpec } = await import('./view.ts')

/**
 * A working list must size to its content. Viewport-clamped flex children
 * can collapse under surrounding chrome and leave rows overlapping actions.
 * Verify the emitted render tree and shared list composition together.
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
    statusLabel: 'Status',
    depthRows: null,
    depthColumns: null,
    depthEmpty: 'None',
    setupSections: [],
    showCreate: false,
    setupHref: null,
    setupLabel: 'Configure recruiting',
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
  const matches = grids.filter((grid) => findBlocks(grid.blocks ?? [], 'widget').some((block) => block.widget === 'registered-record-list'))
  assert.equal(matches.length, 1, 'the register table must live in exactly one grid')
  return matches[0]!
}

test('the recruiting body is not a viewport-locked flex column', () => {
  const className = String(specOf().bodyClassName ?? '')
  for (const clamp of ['h-full', 'h-screen', 'h-dvh', 'h-svh', 'max-h-', 'min-h-screen']) {
    assert.ok(!className.includes(clamp), `the page body must not lock to the viewport (${clamp} collapses the register under the sections)`)
  }
  assert.ok(!tokens(className).includes('flex-col'), 'the page body must stack sections in normal block flow, not as flex items')
})

test('the recruiting register sizes to content, never to the viewport', () => {
  const className = String(registerGrid().className ?? '')
  for (const clamp of ['h-full', 'h-screen', 'h-dvh', 'max-h-']) {
    assert.ok(!className.includes(clamp), `the register grid must not clamp height (${clamp} overflows rows under the sections)`)
  }
  const names = tokens(className)
  assert.ok(!names.includes('flex'), 'the register grid must not be a shrinkable flex item (it collapses under the sections)')
  assert.ok(!names.includes('min-h-0'), 'the register grid must not opt into shrinking below its content (min-h-0 overflows rows under the sections)')
})

test('recruiting has one registered working list and no embedded configuration lists', () => {
  const widgets = findBlocks(registerGrid().blocks ?? [], 'widget')
  assert.equal(widgets.filter((block) => block.widget === 'registered-record-list').length, 1)
  assert.equal(widgets.filter((block) => block.widget === 'setup-section').length, 0)
})
