import { notFound } from 'next/navigation'
import { verifyDocumentSignerToken } from '@openbooks/engine/src/hrm/documents/tokens.ts'
import { readTokenDocument } from '@openbooks/engine/src/hrm/documents/documents.ts'
import { SignDocumentForm } from './SignDocumentForm'

export const dynamic = 'force-dynamic'

/**
 * The signer-facing signing page — public, possession-authenticated by
 * the HMAC token in the link (no session). Shows the document title,
 * the signer timeline (ord/role/status only — party ids and evidence
 * never render), and captures the typed signature (name) or a decline
 * with reason; acknowledgment-only documents offer acknowledge instead.
 * Plain, accessible, mobile-first, no app shell. A link HR sent
 * explains itself even after the switch flips: invalid, voided,
 * expired, and consumed links render the refusal, never a blank page.
 */
export default async function SignDocumentPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (!verifyDocumentSignerToken(token)) notFound()
  let data
  try {
    data = await readTokenDocument(token)
  } catch {
    notFound()
  }
  const timeline = data.signers.map((s) => ({ ord: s.ord, role: s.role, status: s.status }))
  const mine = data.signers.find((s) => s.id === data.viewerSignerId) ?? null
  return (
    <main className="mx-auto min-h-screen max-w-2xl bg-white px-6 py-10 dark:bg-slate-950">
      <p className="text-xs uppercase tracking-widest text-slate-400">Signature requested</p>
      <h1 className="mt-1 text-xl font-semibold text-slate-900 dark:text-slate-100">{data.document.title}</h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Status: {data.document.status}
        {data.document.expiresAt ? ` · Expires ${data.document.expiresAt}` : ''}
      </p>
      <ol className="mb-6 mt-4 flex flex-col gap-1">
        {timeline.map((signer, index) => (
          <li key={index} className="flex justify-between gap-3 text-sm">
            <span>
              {signer.ord + 1}. {signer.role}
              {mine && timeline[index]?.ord === mine.ord ? ' (you)' : ''}
            </span>
            <span className="text-slate-500">{signer.status}</span>
          </li>
        ))}
      </ol>
      {data.document.fileId && (
        <p className="mb-6">
          <a className="text-sm text-teal-700 underline dark:text-teal-300" href={`/api/documents/sign/${token}?format=pdf`}>
            Read the document (PDF)
          </a>
        </p>
      )}
      <SignDocumentForm
        token={token}
        signerStatus={mine?.status ?? 'pending'}
        acknowledgmentOnly={data.acknowledgmentOnly}
      />
    </main>
  )
}
