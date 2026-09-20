/**
 * HRM pipeline stage normalization (pure — no server imports, so unit
 * tests run it directly like hrm-process-template.ts).
 *
 * Terminality derives from kind in storage (0195 CHECK): the Setup drawer
 * edits kind only, and this fold stamps is_terminal before buildRow so the
 * row never trips its own derivation — a hired stage written without the
 * flag is not saved as non-terminal. Unknown kinds pass through untouched;
 * validateEntityIntegrity refuses them by field name.
 */

const TERMINAL_KINDS = new Set(['hired', 'rejected']);

export function normalizeHrmPipelineStageInput(
  entityKey: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (entityKey !== 'hrm-pipeline-stages') return body;
  if (body.kind === undefined) return body;
  return { ...body, isTerminal: TERMINAL_KINDS.has(String(body.kind)) };
}
