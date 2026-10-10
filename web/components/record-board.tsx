import type { ReactNode } from 'react'

export interface RecordBoardLane { value: string; label: string }
export interface RecordBoardCard { id: string; lane: string; title: ReactNode; subtitle?: ReactNode; detail?: ReactNode }

/** A presentation of the same authorized page, not another lifecycle or query. */
export function RecordBoard({ lanes, cards, emptyLabel, pageLabel }: { lanes: RecordBoardLane[]; cards: RecordBoardCard[]; emptyLabel: string; pageLabel: string }) {
  const known = new Set(lanes.map(lane=>lane.value))
  const visibleLanes=[...lanes,...[...new Set(cards.map(card=>card.lane))].filter(value=>!known.has(value)).map(value=>({value,label:value}))]
  return <div className="space-y-2">
    <p className="text-xs text-slate-500">{pageLabel}</p>
    <div className="flex items-start gap-3 overflow-x-auto pb-3" role="list">
      {visibleLanes.map(lane => {
        const records = cards.filter(card => card.lane === lane.value)
        return <section key={lane.value} aria-label={lane.label} className="min-w-[16rem] flex-1 rounded-xl bg-slate-100 p-3 dark:bg-slate-900">
          <header className="mb-3 flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">{lane.label}</h2><span className="rounded-full bg-white px-2 py-0.5 text-xs tabular-nums dark:bg-slate-800">{records.length}</span></header>
          <div className="space-y-2">
            {records.length ? records.map(card => <article key={card.id} className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-950">
              <div className="text-sm font-semibold">{card.title}</div>
              {card.subtitle ? <div className="mt-1 text-xs text-slate-500">{card.subtitle}</div> : null}
              {card.detail ? <div className="mt-3 text-xs">{card.detail}</div> : null}
            </article>) : <p className="rounded-lg border border-dashed border-slate-300 px-3 py-5 text-center text-xs text-slate-500 dark:border-slate-700">{emptyLabel}</p>}
          </div>
        </section>
      })}
    </div>
  </div>
}
