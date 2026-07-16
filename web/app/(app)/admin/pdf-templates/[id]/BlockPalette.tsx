'use client'

import { Braces, Table2 } from 'lucide-react'

type PaletteBlock = {
  getId: () => string
  getLabel: () => unknown
  getCategoryLabel: () => string
}

function blockLabel(block: PaletteBlock): string {
  const value = block.getLabel()
  const label = typeof value === 'string' ? value.trim() : ''
  return label || block.getId()
}

function BlockIcon({ id }: { id: string }) {
  if (id.startsWith('token:')) return <Braces size={19} aria-hidden="true" />
  if (id.startsWith('table:')) return <Table2 size={19} aria-hidden="true" />
  return null
}

/** The drag-in block palette for the PDF builder (content / fields / tables). */
export function BlockPalette<T extends PaletteBlock>({
  mapCategoryBlocks,
  dragStart,
  dragStop,
}: {
  mapCategoryBlocks: Map<string, T[]>
  dragStart: (block: T, event: DragEvent) => void
  dragStop: () => void
}) {
  return (
    <div className="space-y-4 pb-6">
      {Array.from(mapCategoryBlocks.entries()).map(([category, blocks]) => (
        <div key={category || 'general'}>
          <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
            {category || 'Blocks'}
          </p>
          <div className="grid grid-cols-2 gap-1.5">
            {blocks.map((block) => {
              const id = block.getId()
              const label = blockLabel(block)
              return (
                <div
                  key={id}
                  draggable
                  onDragStart={(event) => dragStart(block, event.nativeEvent)}
                  onDragEnd={dragStop}
                  title={label}
                  className="flex cursor-grab flex-col items-center gap-1 rounded-md border border-slate-200 bg-white px-1.5 py-2 text-center text-[10px] leading-tight text-slate-600 shadow-sm transition hover:border-teal-400 hover:text-teal-700 active:cursor-grabbing dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                >
                  <BlockIcon id={id} />
                  <span>{label}</span>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
