import { DECIMAL_RE } from '@openbooks/engine/src/hrm/performance/performance-math.ts'

/**
 * HRM review-template body normalization (pure — no server imports, so
 * unit tests run it directly like hrm-process-template.ts).
 *
 * The Setup drawer edits the rating scale as three structured fields
 * (min, max, labels; never raw JSON — registry.test.ts bars json-kind
 * workforce fields): this fold runs before buildRow on both create and
 * edit so the slot keys never reach the column writer. The scale shape
 * itself is proved in validateEntityIntegrity in write.ts with the
 * engine's own words (parseRatingScale); a malformed scale is refused by
 * field name before the write.
 */

/** Named refusal for a scale bound no decimal reading accepts. */
export class HrmReviewTemplateScaleError extends Error {}

/**
 * Coerce one scale bound to a JSON number. The drawer's integer inputs
 * keep STRING values ('1', '3'), and the storage CHECK only accepts JSON
 * numbers — so a bound the engine's decimal recognition accepts must
 * normalize here, and anything else is refused by field name before the
 * write (the raw CHECK text must never reach the dialog).
 */
function coerceScaleBound(field: 'min' | 'max', slot: string, value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && DECIMAL_RE.test(value)) return Number(value)
  throw new HrmReviewTemplateScaleError(
    `the review template rating scale ${field} must be a number, got ${JSON.stringify(value) ?? 'nothing'} — fix ${slot} before saving`,
  )
}

function normalizeScaleObject(
  scale: Record<string, unknown>,
  slotFor: (field: 'min' | 'max') => string,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...scale }
  if (scale.min !== undefined) normalized.min = coerceScaleBound('min', slotFor('min'), scale.min)
  if (scale.max !== undefined) normalized.max = coerceScaleBound('max', slotFor('max'), scale.max)
  return normalized
}

export function normalizeHrmReviewTemplateInput(
  entityKey: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (entityKey !== 'hrm-review-templates') return body
  const { ratingScaleMin, ratingScaleMax, ratingScaleLabels, ratingScale, ...rest } = body
  const hasSlots =
    ratingScaleMin !== undefined || ratingScaleMax !== undefined || ratingScaleLabels !== undefined
  // A directly posted scale object gets the same number coercion as the
  // folded slots: API callers post ratingScale, the drawer posts slots.
  const direct =
    !hasSlots && ratingScale !== undefined && typeof ratingScale === 'object' && ratingScale !== null
      ? normalizeScaleObject(ratingScale as Record<string, unknown>, (field) =>
          field === 'min' ? 'ratingScale.min' : 'ratingScale.max',
        )
      : undefined
  if (!hasSlots && direct === undefined) return body
  const scale: Record<string, unknown> = {}
  if (ratingScaleMin !== undefined) scale.min = coerceScaleBound('min', 'ratingScaleMin', ratingScaleMin)
  if (ratingScaleMax !== undefined) scale.max = coerceScaleBound('max', 'ratingScaleMax', ratingScaleMax)
  if (ratingScaleLabels !== undefined) scale.labels = ratingScaleLabels
  return { ...rest, ratingScale: hasSlots ? scale : direct }
}
