import type { Block, PageSpec } from '@braedonsaunders/appkit-viewspec'

/**
 * A page layout described as an outline a person can read and rearrange.
 *
 * A `PageSpec` is a precise document and a poor thing to hand someone who
 * wants to move a panel. This turns one into a tree of named blocks with a
 * path to each, so the editor can offer the two operations that are both
 * useful and always safe — hide a block, move it among its siblings — without
 * the author ever seeing a brace.
 *
 * Both operations are structural: they remove or reorder blocks that were
 * already there. Neither can invent a widget, bind a field that does not
 * exist, or produce a document the schema would reject, which is why the
 * structure editor needs no validation step of its own. The JSON editor
 * beside it can do all three, and does get validated.
 *
 * Deliberately free of display strings. A node reports its `kind` and the
 * most identifying value it carries; the client renders that through
 * next-intl. Returning English here would make the editor the one part of the
 * app that cannot be translated.
 *
 * Pure, no `server-only`: the loader builds the outline and the client
 * component re-derives it after every edit, so it must run in both.
 */

/** Where a block sits in a spec: `['body', 2, 'blocks', 0]`. */
export type BlockPath = (string | number)[]

export interface OutlineNode {
  path: BlockPath
  kind: Block['kind']
  /**
   * The value that identifies this block to a reader — a heading's text, a
   * widget's name, a table's row field. Null when the block carries nothing
   * identifying.
   */
  name: string | null
  /** True when `name` is a field path the loader fills, not a literal. */
  nameIsBinding: boolean
  /** Columns, tiles, or child blocks — whichever the kind counts. */
  count: number | null
  /** The block carries a `when` flag, so the page may omit it for some readers. */
  conditional: boolean
  children: OutlineNode[]
}

export interface SpecOutline {
  header: OutlineNode[]
  body: OutlineNode[]
}

function isRef(value: unknown): value is { $: string } {
  return typeof value === 'object' && value !== null && '$' in value
    && typeof (value as { $: unknown }).$ === 'string'
}

/** A `Value<string>` as display text, and whether it was a binding. */
function nameOf(value: unknown): { name: string | null; nameIsBinding: boolean } {
  if (isRef(value)) return { name: value.$, nameIsBinding: true }
  if (typeof value === 'string' && value.trim() !== '') return { name: value, nameIsBinding: false }
  return { name: null, nameIsBinding: false }
}

/** The child-block array a container kind holds, with the key that reaches it. */
function childrenKey(block: Block): 'blocks' | null {
  switch (block.kind) {
    case 'grid':
    case 'panel':
    case 'paper':
    case 'repeat':
    case 'frame':
      return 'blocks'
    default:
      return null
  }
}

function describe(block: Block): Pick<OutlineNode, 'name' | 'nameIsBinding' | 'count'> {
  switch (block.kind) {
    case 'page-header':
      return { ...nameOf(block.title), count: block.actions?.length ?? null }
    case 'heading':
      return { ...nameOf(block.content), count: null }
    case 'text':
      return { ...nameOf(block.content), count: null }
    case 'summary-line':
      return { ...nameOf(block.label), count: null }
    case 'panel':
      return { ...nameOf(block.title), count: block.blocks.length }
    case 'paper':
      return { ...nameOf(block.title), count: block.blocks.length }
    case 'stat-tile':
      return { ...nameOf(block.label), count: null }
    case 'widget':
      // The widget NAME is the identifying thing, and it is a literal in the
      // document rather than a bound value — a spec cannot compute one.
      return { name: block.widget, nameIsBinding: false, count: null }
    case 'frame':
      return { name: block.frame, nameIsBinding: false, count: block.blocks.length }
    case 'table':
      return { ...nameOf(block.rows), count: block.columns.length }
    case 'repeat':
      return { ...nameOf(block.items), count: block.blocks.length }
    case 'grid':
      return { name: null, nameIsBinding: false, count: block.blocks.length }
    case 'filter-bar':
      return { name: null, nameIsBinding: false, count: Object.values(block.controls).filter(Boolean).length }
    case 'pagination':
      return { ...nameOf(block.total), count: null }
    default:
      return { name: null, nameIsBinding: false, count: null }
  }
}

function outlineBlocks(blocks: Block[], prefix: BlockPath): OutlineNode[] {
  return blocks.map((block, index) => {
    const path = [...prefix, index]
    const key = childrenKey(block)
    return {
      path,
      kind: block.kind,
      ...describe(block),
      conditional: 'when' in block && block.when !== undefined,
      children: key
        ? outlineBlocks((block as { blocks: Block[] }).blocks, [...path, key])
        : [],
    }
  })
}

export function outlineSpec(spec: PageSpec): SpecOutline {
  return {
    header: outlineBlocks(spec.header, ['header']),
    body: outlineBlocks(spec.body, ['body']),
  }
}

/** The array a path points into, and the index within it. */
function locate(spec: PageSpec, path: BlockPath): { list: Block[]; index: number } | null {
  if (path.length < 2) return null
  let current: unknown = spec
  for (const segment of path.slice(0, -1)) {
    if (current === null || typeof current !== 'object') return null
    current = (current as Record<string | number, unknown>)[segment]
  }
  const index = path[path.length - 1]
  if (!Array.isArray(current) || typeof index !== 'number') return null
  if (index < 0 || index >= current.length) return null
  return { list: current as Block[], index }
}

/**
 * A spec with one block removed, or the original when the path misses.
 *
 * Returning the ORIGINAL object on a miss (rather than a clone, or throwing)
 * lets the caller detect a no-op by identity and skip pushing a pointless
 * undo entry.
 */
export function removeBlock(spec: PageSpec, path: BlockPath): PageSpec {
  const next = structuredClone(spec)
  const at = locate(next, path)
  if (!at) return spec
  at.list.splice(at.index, 1)
  return next
}

/** A spec with one block swapped with its neighbour. `delta` is -1 or 1. */
export function moveBlock(spec: PageSpec, path: BlockPath, delta: -1 | 1): PageSpec {
  const next = structuredClone(spec)
  const at = locate(next, path)
  if (!at) return spec
  const target = at.index + delta
  if (target < 0 || target >= at.list.length) return spec
  const [block] = at.list.splice(at.index, 1)
  at.list.splice(target, 0, block!)
  return next
}

/** Total blocks at every depth — the headline number for "how big is this page". */
export function countBlocks(outline: SpecOutline): number {
  const walk = (nodes: OutlineNode[]): number =>
    nodes.reduce((total, node) => total + 1 + walk(node.children), 0)
  return walk(outline.header) + walk(outline.body)
}
