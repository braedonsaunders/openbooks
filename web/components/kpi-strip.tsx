import { Card, CardContent, cn } from '@openbooks/ui'

export interface Kpi {
  label: string
  value: string
  tone?: 'good' | 'bad'
  suffix?: string
}

/**
 * A SINGLE horizontal row of KPI tiles (AGENTS.md: never stack two rows of
 * KPIs). Tiles keep a min width and the strip scrolls horizontally when there
 * are more than fit — never wrapping into a second row.
 */
export function KpiStrip({ items }: { items: Kpi[] }) {
  if (items.length === 0) return null
  return (
    <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]">
      {items.map((k) => (
        <Card key={k.label} className="min-w-[9.5rem] flex-1 shrink-0">
          <CardContent className="p-4">
            <span className="block truncate text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
              {k.label}
            </span>
            <span
              className={cn(
                'mt-0.5 block text-xl font-semibold tabular-nums',
                k.tone === 'good' && 'text-teal-700 dark:text-teal-300',
                k.tone === 'bad' && 'text-red-600 dark:text-red-400',
              )}
            >
              {k.value}
              {k.suffix ? (
                <span className="text-sm font-normal text-slate-500 dark:text-slate-400"> {k.suffix}</span>
              ) : null}
            </span>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
