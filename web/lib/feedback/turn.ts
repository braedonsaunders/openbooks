import { z } from 'zod'
import type { FeedbackToolPart } from '@braedonsaunders/appkit-feedback'
import { uuidId } from '../api/json'

/**
 * The request boundary and model-result adaptation for the issue reporter's
 * turn route. Pure, so the bounds a publicly reachable route depends on can
 * be tested without a model, a database, or a network.
 */

const MAX_TEXT_CHARS = 4_000
const MAX_PATHNAME_CHARS = 2_048
const MAX_PAGE_TITLE_CHARS = 200
const MAX_ANSWERS = 8
const MAX_ANSWER_CHARS = 1_000

/**
 * Ceiling on the raw request. Checked against the declared content length
 * before the body is read, so an oversized report is refused as 413 rather
 * than arriving as a schema failure the reporter cannot interpret.
 */
export const MAX_FEEDBACK_REQUEST_BYTES = 32 * 1024

export type FeedbackTurnRequest = {
  text: string
  pathname: string
  pageTitle?: string
  answers: Record<string, string>
  forceFile: boolean
  includePage: boolean
  sessionId: string | null
}

/**
 * Raw ceilings on the answers object, enforced BEFORE the transform below.
 * The transform already caps kept answers and truncates values, but it runs
 * after the whole object is parsed — these refinements refuse an object that
 * is large by construction (thousands of keys, megabyte values) with a named
 * schema failure instead of buffering it into the trim-and-drop loop.
 */
const MAX_ANSWER_KEY_CHARS = 128
const MAX_RAW_ANSWER_CHARS = 4_000

/** Answers to the model's clarifying questions: bounded, trimmed, blanks dropped. */
const answers = z
  .record(z.string(), z.unknown())
  .refine(
    (raw) => Object.keys(raw).length <= MAX_ANSWERS,
    `at most ${MAX_ANSWERS} answers are accepted`,
  )
  .refine(
    (raw) => Object.keys(raw).every((key) => key.length <= MAX_ANSWER_KEY_CHARS),
    `answer ids must be at most ${MAX_ANSWER_KEY_CHARS} characters`,
  )
  .refine(
    (raw) =>
      Object.values(raw).every(
        (value) => typeof value !== 'string' || value.length <= MAX_RAW_ANSWER_CHARS,
      ),
    `an answer must be at most ${MAX_RAW_ANSWER_CHARS} characters`,
  )
  .transform((raw): Record<string, string> => {
    const kept: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value !== 'string') continue
      const answer = value.trim().slice(0, MAX_ANSWER_CHARS)
      if (!answer) continue
      kept[key] = answer
      if (Object.keys(kept).length >= MAX_ANSWERS) break
    }
    return kept
  })

export const feedbackTurnBody = z
  .object({
    text: z.string().trim().min(1, 'a report is required').max(MAX_TEXT_CHARS),
    context: z
      .object({
        pathname: z.string().max(MAX_PATHNAME_CHARS).optional(),
        pageTitle: z.string().max(MAX_PAGE_TITLE_CHARS).optional(),
      })
      .optional(),
    answers: answers.optional(),
    forceFile: z.boolean().optional(),
    // Page context is opt-OUT: the reporter sees the chip and removes it.
    includePage: z.boolean().optional(),
    sessionId: z.union([uuidId, z.null()]).optional(),
  })
  .transform(
    (body): FeedbackTurnRequest => ({
      text: body.text,
      pathname: body.context?.pathname || '/',
      pageTitle: body.context?.pageTitle,
      answers: body.answers ?? {},
      forceFile: body.forceFile === true,
      includePage: body.includePage !== false,
      sessionId: body.sessionId ?? null,
    }),
  )

/**
 * The model's tool results in the shape the package's interpreter reads.
 * Both the AI SDK's `toolResults` and its content parts are collected: which
 * one carries the call depends on the provider, and the reporter's whole
 * outcome is decided by the last tool the model reached.
 */
export function feedbackToolPartsFromResult(result: {
  steps?: readonly {
    toolResults?: readonly { toolName?: string; output?: unknown }[]
    content?: readonly { type?: string; toolName?: string; output?: unknown }[]
  }[]
}): FeedbackToolPart[] {
  const parts: FeedbackToolPart[] = []
  for (const step of result.steps ?? []) {
    for (const item of step.toolResults ?? []) {
      if (typeof item?.toolName === 'string' && item.toolName.trim()) {
        parts.push({ toolName: item.toolName, state: 'output-available', output: item.output })
      }
    }
    for (const item of step.content ?? []) {
      if (!item || typeof item !== 'object') continue
      const type = typeof item.type === 'string' ? item.type : ''
      if (type !== 'tool-result' && !type.startsWith('tool-')) continue
      parts.push({ type, toolName: item.toolName, state: 'output-available', output: item.output })
    }
  }
  return parts
}
