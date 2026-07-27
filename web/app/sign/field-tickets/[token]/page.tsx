import { notFound } from 'next/navigation'
import { withOrgContext } from '@openbooks/engine/src/db.ts'
import { validateSigningRequest, verifySigningToken } from '../../../../lib/field-ticket-token'
import { loadFieldTicket } from '../../../../lib/field-tickets'
import { SignTicketForm } from './SignTicketForm'

export const dynamic = 'force-dynamic'

/**
 * The customer-facing signing page — public, possession-authenticated by the
 * HMAC token in the link (no session; RLS scoped explicitly to the token's
 * org). Shows the ticket summary and captures the drawn signature.
 */
export default async function SignFieldTicketPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const verified = verifySigningToken(token)
  if (!verified) notFound()

  let ticket
  try {
    ticket = await withOrgContext(verified.orgId, async () => {
      if (!(await validateSigningRequest(token, verified, { allowResponded: true }))) {
        throw new Error('Signing request is not valid')
      }
      return loadFieldTicket(verified.orgId, verified.ticketId)
    })
  } catch {
    notFound()
  }
  if (ticket.status !== 'approved') notFound()

  const alreadySigned = !!ticket.fieldTicket.signatures?.customer
  const crewSummary = new Map<string, number>()
  for (const e of ticket.entries) {
    crewSummary.set(e.employee_name, (crewSummary.get(e.employee_name) ?? 0) + Number(e.hours))
  }

  return (
    <main className="mx-auto min-h-screen max-w-2xl bg-white px-6 py-10 dark:bg-slate-950">
      <div className="mb-6">
        <p className="text-xs uppercase tracking-widest text-slate-400">{ticket.customerName}</p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900 dark:text-slate-100">
          {ticket.documentNumber}
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {ticket.projectName} · {ticket.fieldTicket.periodStart}
          {ticket.fieldTicket.period === 'weekly' ? ` → ${ticket.fieldTicket.periodEnd}` : ''}
        </p>
      </div>

      {ticket.memo && (
        <p className="mb-5 whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-sm text-slate-700 dark:bg-slate-900 dark:text-slate-200">
          {ticket.memo}
        </p>
      )}

      <table className="mb-5 w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
            <th className="border-b-2 border-slate-900 pb-1 dark:border-slate-100">Crew</th>
            <th className="border-b-2 border-slate-900 pb-1 text-right dark:border-slate-100">Hours</th>
          </tr>
        </thead>
        <tbody>
          {[...crewSummary.entries()].map(([name, hours]) => (
            <tr key={name} className="border-b border-slate-100 dark:border-slate-800">
              <td className="py-1.5 text-slate-800 dark:text-slate-100">{name}</td>
              <td className="py-1.5 text-right tabular-nums text-slate-800 dark:text-slate-100">{hours.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {ticket.lines.length > 0 && (
        <table className="mb-5 w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="border-b-2 border-slate-900 pb-1 dark:border-slate-100">Equipment & materials</th>
              <th className="border-b-2 border-slate-900 pb-1 text-right dark:border-slate-100">Qty</th>
            </tr>
          </thead>
          <tbody>
            {ticket.lines.map((l) => (
              <tr key={l.id} className="border-b border-slate-100 dark:border-slate-800">
                <td className="py-1.5 text-slate-800 dark:text-slate-100">{l.item_name ?? l.description}</td>
                <td className="py-1.5 text-right tabular-nums text-slate-800 dark:text-slate-100">{Number(l.quantity)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <SignTicketForm token={token} alreadySigned={alreadySigned} signedBy={ticket.fieldTicket.signatures?.customer?.name ?? null} />
    </main>
  )
}
