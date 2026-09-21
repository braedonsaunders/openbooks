import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { readBookingLink } from '@openbooks/engine/src/hrm/recruiting/scheduling.ts'
import { isFeatureEnabled } from '../../../lib/features'
import { resolvePublicOrgFeatures } from '../../../lib/recruiting-public'
import { BookSlotForm } from './BookSlotForm'

export const dynamic = 'force-dynamic'

/**
 * Candidate self-booking page — public, possession-authenticated by the
 * HMAC token in the link (no session). Renders the live proposed slots
 * outside the app shell: plain, accessible, mobile-first. An invalid or
 * expired link 404s; the page never reveals whether the interview exists.
 */
export default async function BookInterviewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const t = await getTranslations('hrm')
  let link
  try {
    link = await readBookingLink(decodeURIComponent(token))
  } catch {
    notFound()
  }
  const features = await resolvePublicOrgFeatures(link.interviewId, 'interview')
  if (!features) notFound()
  if (!(await isFeatureEnabled(features.orgId, 'hrmRecruiting'))) notFound()
  if (!(await isFeatureEnabled(features.orgId, 'hrmInterviewScheduling'))) notFound()

  return (
    <main className="mx-auto min-h-screen max-w-2xl bg-white px-6 py-10">
      <p className="text-xs uppercase tracking-widest text-slate-400">{t('public.book.kicker')}</p>
      <h1 className="mt-1 text-xl font-semibold">{t('public.book.title', { name: link.candidateName })}</h1>
      {link.slots.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">{t('public.book.empty')}</p>
      ) : (
        <div className="mt-6">
          <BookSlotForm token={decodeURIComponent(token)} slots={[...link.slots]} />
        </div>
      )}
    </main>
  )
}
