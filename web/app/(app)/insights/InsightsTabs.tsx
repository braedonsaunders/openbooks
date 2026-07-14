import Link from 'next/link'

/** Sub-navigation between the Cards library and the Dashboards grid. */
export function InsightsTabs({ active }: { active: 'cards' | 'dashboards' }) {
  const tabs = [
    { key: 'cards', label: 'Cards', href: '/insights' },
    { key: 'dashboards', label: 'Dashboards', href: '/insights/dashboards' },
  ] as const
  return (
    <div className="flex items-center gap-1 border-b border-slate-200 dark:border-slate-800">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={
            'border-b-2 px-3 py-2 text-sm font-medium transition-colors ' +
            (active === t.key
              ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300'
              : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200')
          }
        >
          {t.label}
        </Link>
      ))}
    </div>
  )
}
