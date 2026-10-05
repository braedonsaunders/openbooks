'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Badge, EmptyState } from '@openbooks/ui'
import { apiJson } from '@/lib/api-error'
import { ListDrawerLink } from '@/components/list-drawer-link'

interface Sibling {
  id: string
  code: string | null
  name: string
  optionValues: Record<string, string>
  isActive: boolean
}

/**
 * Sibling variants of the open item with links back into this drawer, plus
 * the one-click route into the family workspace. Follows the Pricing tab:
 * the tab owns its data and loads it when opened.
 */
export function ItemVariantsTab({ familyId, itemId }: { familyId: string; itemId: string }) {
  const t = useTranslations('items.families')
  const tCommon = useTranslations('common')
  const [siblings, setSiblings] = useState<Sibling[] | null>(null)
  const [familyCode, setFamilyCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    apiJson<{ code: string; variants: Sibling[] }>(`/api/item-families/${familyId}`)
      .then((detail) => {
        if (cancelled) return
        setFamilyCode(detail.code)
        setSiblings(detail.variants)
      })
      .catch((loadError: unknown) => {
        if (cancelled) return
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      })
    return () => {
      cancelled = true
    }
  }, [familyId])

  if (error) {
    return (
      <EmptyState
        title={t('itemTab.loadFailed')}
        description={error}
        action={
          <Link
            href={`/items/families?family=${familyId}`}
            className="rounded-md border border-slate-200 px-3 py-1.5 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            {t('itemTab.openFamily')}
          </Link>
        }
      />
    )
  }

  if (siblings === null) return <p className="py-6 text-center text-sm text-slate-500">{tCommon('feedback.loading')}</p>

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-slate-500">
          {t('itemTab.siblingCount', { count: siblings.length, family: familyCode })}
        </p>
        <Link
          href={`/items/families?family=${familyId}`}
          className="rounded-md border border-slate-200 px-2.5 py-1.5 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          {t('itemTab.openFamily')}
        </Link>
      </div>
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
        {siblings.map((sibling) => (
          <li key={sibling.id}>
            <ListDrawerLink
              href={`/items?item=${sibling.id}`}
              className={
                'flex items-center gap-3 px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800' +
                (sibling.id === itemId ? ' bg-teal-50/50 dark:bg-teal-950/30' : '')
              }
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{sibling.name}</span>
                <span className="block truncate font-mono text-xs text-slate-500">
                  {sibling.code ?? ''} · {Object.values(sibling.optionValues).join(' / ')}
                </span>
              </span>
              <Badge variant={sibling.isActive ? 'success' : 'outline'}>
                {sibling.isActive ? tCommon('status.active') : tCommon('status.inactive')}
              </Badge>
            </ListDrawerLink>
          </li>
        ))}
      </ul>
    </section>
  )
}
