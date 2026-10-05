import { getTranslations } from 'next-intl/server'
import { PortalShell } from '@/components/portal/portal-shell'
import { SignInForm } from '@/components/portal/portal-client'

export default async function PortalRequestPage() {
  const t = await getTranslations('portal')
  return (
    <PortalShell title={t('request.title')}>
      <p className="mb-4 text-center text-sm text-slate-500 dark:text-slate-400">{t('request.detail')}</p>
      <SignInForm requestLabel={t('request.submit')} emailLabel={t('request.email')} sentText={t('request.sent')} />
    </PortalShell>
  )
}
