import { randomUUID } from 'node:crypto'
import { generateText, stepCountIs } from 'ai'
import { getLocale, getTranslations } from 'next-intl/server'
import {
  composeFeedbackUserMessage,
  createFeedbackTools,
  createGithubIssuePublisher,
  createScriptedFeedbackClient,
  feedbackSystemPrompt,
  interpretFeedbackTurn,
  type FeedbackContext,
  type FeedbackTurnResult,
  type IssuePublisher,
} from '@braedonsaunders/appkit-feedback'
import { can, getAuthz } from '../../../../lib/authz'
import { getOrgAiConfig } from '../../../../lib/assistant/ai-config'
import { AIDisabledError, getModel } from '../../../../lib/assistant/client'
import { orgInfo } from '../../../../lib/data'
import {
  createIntentFirstPublisher,
  feedbackAuditPendingMessage,
  FeedbackFilingRefusedError,
  feedbackFilingRefusedMessage,
  recordFeedbackFiledAudit,
} from '../../../../lib/feedback/audit'
import { feedbackDenyList, getFeedbackRuntime } from '../../../../lib/feedback/config'
import { feedbackGithubRequest } from '../../../../lib/feedback/github'
import { createFeedbackKnowledge } from '../../../../lib/feedback/knowledge'
import { parseJsonBody } from '../../../../lib/api/json'
import {
  MAX_FEEDBACK_REQUEST_BYTES,
  feedbackToolPartsFromResult,
  feedbackTurnBody,
} from '../../../../lib/feedback/turn'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * One turn of the in-app issue reporter (@braedonsaunders/appkit-feedback).
 *
 * The package owns the conversation shape, the redaction, and the GitHub
 * adapter; this route owns everything that is authority or identity — the
 * session, the permission, the organization's model, the sealed destination
 * credential, the outbound request, and the audit record. That split is why
 * the package can be reused by other applications without any of them
 * inheriting this deployment's secrets.
 *
 * A turn ends in one of four ways: guidance from the help centre, at most two
 * clarifying questions, a filed (generalized) issue, or "unavailable". When
 * the organization has no model configured, the scripted client still files —
 * an unreported defect is worse than an unpolished issue.
 */

export async function POST(req: Request): Promise<Response> {
  const authz = await getAuthz()
  if (!authz) return new Response('Unauthorized', { status: 401 })
  if (!can(authz, 'feedback.use')) return new Response('Forbidden', { status: 403 })
  const { id: userId, orgId } = authz.user

  const t = await getTranslations('shell.feedback')
  const unavailable = (): FeedbackTurnResult => ({
    kind: 'unavailable',
    message: t('unavailableBody'),
  })

  // Refused while the body is READ, not from the caller-controlled
  // Content-Length header: a chunked upload has no header and a lying one is
  // just bytes with an opinion. An oversized report is a size problem, and
  // parseJsonBody answers it as a 413 (with a `message` the dialog surfaces)
  // rather than a schema failure telling the reporter to rewrite text that
  // was never the issue.
  const parsed = await parseJsonBody(req, feedbackTurnBody, {
    maxBodyBytes: MAX_FEEDBACK_REQUEST_BYTES,
  })
  if (!parsed.ok) return parsed.response
  const request = parsed.data

  const [destination, aiConfig, org, locale] = await Promise.all([
    getFeedbackRuntime(),
    getOrgAiConfig(orgId),
    orgInfo(orgId),
    getLocale(),
  ])
  if (!destination) {
    // Not an error the reporter can act on: the operator has not finished
    // configuring a destination, so say so rather than dropping their text.
    console.warn('[feedback/turn] no destination configured')
    return Response.json(unavailable(), { status: 503 })
  }

  const context: FeedbackContext = {
    pathname: request.includePage ? request.pathname : '/',
    pageTitle: request.includePage ? request.pageTitle : undefined,
    appVersion: process.env.OPENBOOKS_VERSION || 'development',
    locale,
  }
  // What the filed issue must never carry verbatim. The package strips
  // structural PII on its own; these are the values only the host knows.
  const denyList = feedbackDenyList([authz.user.name, authz.user.email, org?.name])

  const github = createGithubIssuePublisher({
    owner: destination.owner,
    repo: destination.repo,
    token: destination.token,
    labels: destination.labels,
    request: feedbackGithubRequest,
  })
  // Withholding `searchOpen` is how the operator's "search open issues first"
  // switch is enforced — the model cannot reach a capability it was not given.
  const searchScoped: IssuePublisher = destination.searchDuplicates
    ? github
    : { create: (draft) => github.create(draft) }
  // One report id for the whole turn: the intent row and its completion row
  // share it, so an intent with no completion sibling is pending work — never
  // a silent success.
  const reportId = randomUUID()
  const refusal: { error: FeedbackFilingRefusedError | null } = { error: null }
  // The intent row lands BEFORE the wrapped publisher files anything. If the
  // intent cannot be written the wrapper throws and nothing is published.
  const publisher = createIntentFirstPublisher(
    searchScoped,
    {
      orgId,
      actorId: userId,
      reportId,
      owner: destination.owner,
      repo: destination.repo,
      pathname: context.pathname,
      refusal,
    },
  )
  const knowledge = createFeedbackKnowledge()

  /** A computed refusal the package may have swallowed — raised here instead. */
  function raisedRefusal(result: FeedbackTurnResult): Response | null {
    if (refusal.error && result.kind === 'unavailable') {
      return Response.json(
        { kind: 'unavailable', message: feedbackFilingRefusedMessage() },
        { status: 503 },
      )
    }
    return null
  }

  async function finish(result: FeedbackTurnResult): Promise<Response> {
    const swallowed = raisedRefusal(result)
    if (swallowed) return swallowed
    if (result.kind === 'filed') {
      try {
        await recordFeedbackFiledAudit({
          orgId,
          actorId: userId,
          reportId,
          result,
          pathname: context.pathname,
        })
      } catch (error) {
        // The issue is already public; losing the evidence write must not
        // also lose the person's answer — but it must not read as a clean
        // filing either. The intent row is durable and reconcilable, and the
        // reporter is told exactly that (including the issue link, and not to
        // re-file).
        console.error('[feedback/turn] failed to record audit evidence', error)
        return Response.json({
          kind: 'unavailable',
          message: feedbackAuditPendingMessage(result.issue),
        })
      }
    }
    return Response.json(result)
  }

  const runScripted = (forceFile: boolean) =>
    createScriptedFeedbackClient({
      knowledge,
      publisher,
      defaultLabels: destination.labels,
      unavailableMessage: t('unavailableBody'),
    }).send({ text: request.text, context, answers: request.answers, forceFile })

  const model = getModel(aiConfig, 'fast')
  if (!model) {
    console.warn('[feedback/turn] AI is not configured; filing without triage')
    return finish(await runScripted(request.forceFile))
  }

  try {
    const generated = await generateText({
      model,
      system: feedbackSystemPrompt({ productName: 'OpenBooks', forceFile: request.forceFile }),
      prompt: composeFeedbackUserMessage({
        text: request.text,
        pathname: context.pathname,
        pageTitle: context.pageTitle,
        appVersion: context.appVersion,
        answers: request.answers,
        includePage: request.includePage,
      }),
      tools: createFeedbackTools({
        knowledge,
        publisher,
        context,
        defaultLabels: destination.labels,
        redact: { denyList },
      }),
      stopWhen: stepCountIs(8),
      abortSignal: req.signal,
      temperature: 0.2,
    })
    let result = interpretFeedbackTurn(feedbackToolPartsFromResult(generated))
    if (result.kind === 'unavailable') {
      // The model talked without reaching a terminal tool. File anyway: the
      // report exists, and a triage failure is ours, not the reporter's.
      console.warn('[feedback/turn] model turn reached no terminal tool; filing')
      result = await runScripted(true)
    }
    return finish(result)
  } catch (error) {
    if (!(error instanceof AIDisabledError)) console.error('[feedback/turn] failed', error)
    return finish(await runScripted(true))
  }
}
