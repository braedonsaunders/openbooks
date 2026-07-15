'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Select } from '@openbooks/ui'

export function DimensionFilter({
  departments,
  projects,
}: {
  departments: { id: string; name: string }[]
  projects: { id: string; name: string }[]
}) {
  const t = useTranslations('reports.dimensionFilter')
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  function apply(key: 'dept' | 'project', value: string) {
    const next = new URLSearchParams(params.toString())
    if (value) next.set(key, value)
    else next.delete(key)
    router.replace(`${pathname}?${next.toString()}`)
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={params.get('dept') ?? ''}
        onChange={(e) => apply('dept', e.target.value)}
        className="w-52"
        aria-label={t('departmentAria')}
      >
        <option value="">{t('allDepartments')}</option>
        {departments.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </Select>
      <Select
        value={params.get('project') ?? ''}
        onChange={(e) => apply('project', e.target.value)}
        className="w-52"
        aria-label={t('projectAria')}
      >
        <option value="">{t('allProjects')}</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
    </div>
  )
}
