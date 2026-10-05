import type { ReactNode } from 'react'

/** Public portal shell: the same centered-card composition as hosted pay. */
export function PortalShell({ orgName, title, children }: { orgName?: string; title: string; children: ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-slate-100 p-4 dark:bg-slate-950">
      <main className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-sm dark:bg-slate-900 sm:p-8">
        {orgName ? <p className="text-center text-sm font-medium text-slate-500 dark:text-slate-400">{orgName}</p> : null}
        <h1 className="mt-1 text-center text-xl font-semibold text-slate-900 dark:text-white">{title}</h1>
        <div className="mt-6">{children}</div>
      </main>
    </div>
  )
}

export function PortalSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-6 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-900 dark:text-white">{title}</h2>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  )
}

export function PortalEmpty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-slate-500 dark:text-slate-400">{children}</p>
}

export function PortalNav({
  token,
  sections,
  activeHref,
  ariaLabel = 'Portal sections',
}: {
  token: string
  sections: Array<{ href: string; label: string }>
  /** Full href of the current link: marked with aria-current and the active tone. */
  activeHref?: string
  ariaLabel?: string
}) {
  return (
    <nav className="mt-6 flex flex-wrap gap-2" aria-label={ariaLabel}>
      {sections.map((section) => {
        const href = `/portal/${token}${section.href}`
        const active = activeHref === href
        return (
          <a
            key={section.href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${active
              ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300'
              : 'border-slate-200 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800'}`}
          >
            {section.label}
          </a>
        )
      })}
    </nav>
  )
}
