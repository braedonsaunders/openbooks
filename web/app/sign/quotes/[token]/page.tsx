import { QuoteSignForm } from './QuoteSignForm'

export const dynamic = 'force-dynamic'

/**
 * Hosted quote signing page: the customer reviews the ramp-priced
 * subscription and signs with no account. Composed on the hosted payment
 * page — one narrow card, plain language, link-state refusals in words.
 */
export default async function QuoteSignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center gap-4 px-4 py-10">
      <header className="text-center">
        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Review and sign</p>
      </header>
      <QuoteSignForm token={token} />
      <p className="text-center text-xs text-slate-500">
        Signing records your name, the time, and the exact quoted terms.
      </p>
    </div>
  )
}
