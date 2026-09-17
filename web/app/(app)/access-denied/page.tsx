import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ShieldAlert } from 'lucide-react'
import { getTranslations } from 'next-intl/server'
import { Button } from '@openbooks/ui'
import { RouteStateView } from '@/components/route-state'
import { getAuthz } from '../../../lib/authz'

export const dynamic = 'force-dynamic'

function singleParam(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value
  return first && first.length > 0 ? first : undefined
}

/**
 * The shared explanation for a refused visitor (F-t12-001, F-t13-008).
 * Gates redirect here instead of silently bouncing home: the page names the
 * missing permission (or the operator-only scope) and points at the person
 * who can grant it. The key is echoed as text only, never looked up, so any
 * non-empty value renders honestly; a bare visit with no context 404s.
 */
export default async function AccessDeniedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const scope = singleParam(sp.scope)
  const permission = singleParam(sp.permission)
  if (scope !== 'platform' && !permission) {
    notFound()
  }
  const authz = await getAuthz()
  if (!authz) redirect('/login')
  const t = await getTranslations('shell.routeState')
  const description =
    scope === 'platform'
      ? t('operatorDescription')
      : t('deniedDescription', { permission: permission ?? '' })
  return (
    <RouteStateView
      state="forbidden"
      icon={<ShieldAlert />}
      title={t('deniedTitle')}
      description={description}
      action={
        <Button asChild>
          <Link href="/dashboard">{t('backToDashboard')}</Link>
        </Button>
      }
      footer={t('askAdministrator')}
    />
  )
}
