import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { readOfferForSigning } from '@openbooks/engine/src/hrm/recruiting/offers-signing.ts'
import { isFeatureEnabled } from '../../../lib/features'
import { resolvePublicOrgFeatures } from '../../../lib/recruiting-public'
import { OfferSignForm } from './OfferSignForm'

export const dynamic = 'force-dynamic'

/**
 * Offer signing page — public, possession-authenticated by the HMAC token
 * in the link (no session). Shows the offer terms and captures the typed
 * signature or the decline reason, outside the app shell: plain,
 * accessible, mobile-first. Invalid, expired, signed, declined, or voided
 * links render their recorded state — token reuse changes nothing.
 */
export default async function OfferSigningPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const t = await getTranslations('hrm')
  let offer
  try {
    offer = await readOfferForSigning(decodeURIComponent(token))
  } catch {
    notFound()
  }
  const features = await resolvePublicOrgFeatures(offer.offerId, 'offer')
  if (!features) notFound()
  if (!(await isFeatureEnabled(features.orgId, 'hrmRecruiting'))) notFound()
  if (!(await isFeatureEnabled(features.orgId, 'hrmOfferSigning'))) notFound()

  return (
    <main className="mx-auto min-h-screen max-w-2xl bg-white px-6 py-10">
      <p className="text-xs uppercase tracking-widest text-slate-400">{t('public.offer.kicker')}</p>
      <h1 className="mt-1 text-xl font-semibold">{offer.jobTitle}</h1>
      <p className="mt-1 text-sm text-slate-500">
        {t('public.offer.for', { name: offer.candidateName })} · {t('public.offer.version', { version: offer.version })}
      </p>
      <section aria-label={t('public.offer.terms')} className="mt-6 rounded-md border border-slate-200 bg-slate-50 p-4">
        <h2 className="text-sm font-semibold text-slate-700">{t('public.offer.terms')}</h2>
        <p className="mt-2 whitespace-pre-wrap text-sm text-slate-800">{offer.letter}</p>
      </section>
      {offer.signatureStatus === 'signed' ? (
        <p role="status" className="mt-6 rounded-md bg-green-50 p-4 text-sm text-green-800">
          {t('public.offer.alreadySigned')}
        </p>
      ) : offer.signatureStatus === 'declined' || offer.signatureStatus === 'voided' ? (
        <p role="status" className="mt-6 rounded-md bg-slate-100 p-4 text-sm text-slate-700">
          {t('public.offer.closed')}
        </p>
      ) : (
        <div className="mt-6">
          <OfferSignForm
            token={decodeURIComponent(token)}
            candidateName={offer.candidateName}
            documentHash={offer.documentHash}
          />
        </div>
      )}
    </main>
  )
}
