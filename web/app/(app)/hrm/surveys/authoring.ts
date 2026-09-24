/**
 * Surveys author-dialog input parsing (F3-54, F3-68).
 *
 * The author dialog posts question cards typed by an operator. Two inputs
 * need parsing before the POST:
 *
 * - minimum group size: the anonymity threshold. An unparseable or
 *   out-of-range value must REFUSE by name (the caller shows the
 *   minGroupInvalid catalog string) — never silently fall back to 5, which
 *   would move the anonymity threshold under the operator.
 * - options: one choice per line. The editor is multi-line, so the split
 *   runs on newlines and drops blank lines.
 */

export interface AuthorQuestionDraft {
  kind: string
  prompt: string
  options: string
  driverKey: string
}

export interface AuthorPayloadInput {
  name: string
  kind: string
  anonymity: string
  minGroup: string
  questions: AuthorQuestionDraft[]
}

export type AuthorPayload =
  | {
      ok: true
      body: {
        name: string
        kind: string
        anonymity: string
        minGroupSize: number
        questions: { kind: string; prompt: string; options?: string[]; driverKey?: string }[]
      }
    }
  | { ok: false; error: 'minGroupInvalid' }

/** Valid group sizes are whole numbers from 2 to 1000 (the API's range). */
export function parseMinGroupSize(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed) || parsed < 2 || parsed > 1000) return null
  return parsed
}

/** Split a multi-line options draft into non-blank choices. */
export function splitOptions(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * Build the POST body for the author dialog. Refuses with the
 * minGroupInvalid key (rendered from the catalog) instead of coercing a
 * bad threshold into the default.
 */
export function buildSurveyAuthorPayload(input: AuthorPayloadInput): AuthorPayload {
  const minGroupSize = parseMinGroupSize(input.minGroup)
  if (minGroupSize === null) return { ok: false, error: 'minGroupInvalid' }
  return {
    ok: true,
    body: {
      name: input.name,
      kind: input.kind,
      anonymity: input.anonymity,
      minGroupSize,
      questions: input.questions.map((q) => ({
        kind: q.kind,
        prompt: q.prompt,
        ...(q.kind === 'single' || q.kind === 'multi' ? { options: splitOptions(q.options) } : {}),
        ...(q.driverKey.trim() ? { driverKey: q.driverKey.trim() } : {}),
      })),
    },
  }
}
