import { notFound } from 'next/navigation'
import { hashHrmToken, verifySurveyInvitationToken } from '@openbooks/engine/src/hrm/documents/tokens.ts'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { sql } from 'drizzle-orm'
import { SurveyRespondForm } from './SurveyRespondForm'

export const dynamic = 'force-dynamic'

/**
 * The respondent-facing survey page — public, possession-authenticated
 * by the invitation token (no session). Renders the question cards for
 * the survey the invitation names; anonymous surveys say so upfront.
 * Plain, accessible, mobile-first, no app shell. A consumed, expired,
 * or closed-survey link renders the refusal, never a blank page.
 */
export default async function SurveyRespondPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const claims = verifySurveyInvitationToken(token)
  if (!claims) notFound()
  let survey
  try {
    survey = await withOrgTransaction(claims.orgId, async () => {
      const row = (await db.execute<{
        id: string
        name: string
        kind: string
        anonymity: string
        status: string
        closes_at: string | null
        responded: string | null
      }>(sql`
        select s.id, s.name, s.kind, s.anonymity, s.status, s.closes_at::text as closes_at,
               i.responded_at::text as responded
          from hrm_survey_invitations i
          join hrm_surveys s on s.org_id = i.org_id and s.id = i.survey_id
         where i.token_hash = ${hashHrmToken(token)}
      `)).rows[0]
      if (!row || row.status !== 'open' || row.responded) return null
      const questions = (await db.execute<{
        id: string
        kind: string
        prompt: string
        options: unknown
      }>(sql`
        select id, kind, prompt, options from hrm_survey_questions
         where org_id = ${claims.orgId} and survey_id = ${row.id}
         order by position
      `)).rows
      return { ...row, questions }
    })
  } catch {
    survey = null
  }
  if (!survey) notFound()
  return (
    <main className="mx-auto min-h-screen max-w-2xl bg-white px-6 py-10 dark:bg-slate-950">
      <p className="text-xs uppercase tracking-widest text-slate-400">{survey.kind}</p>
      <h1 className="mt-1 text-xl font-semibold text-slate-900 dark:text-slate-100">{survey.name}</h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        {survey.anonymity === 'anonymous'
          ? 'Anonymous — your answers carry no link back to you.'
          : survey.anonymity === 'confidential'
            ? 'Confidential — your identity is stored encrypted and results show only in groups.'
            : 'Named — your name is attached to your answers.'}
        {survey.closes_at ? ` Closes ${survey.closes_at}.` : ''}
      </p>
      <div className="mt-6">
        <SurveyRespondForm
          token={token}
          questions={survey.questions.map((q) => ({
            id: q.id,
            kind: q.kind,
            prompt: q.prompt,
            options: Array.isArray(q.options) ? q.options.map((o) => String(o)) : [],
          }))}
        />
      </div>
    </main>
  )
}
