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

export function normalizeHrmReviewTemplateInput(
  entityKey: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (entityKey !== 'hrm-review-templates') return body
  const hasSlots =
    body.ratingScaleMin !== undefined ||
    body.ratingScaleMax !== undefined ||
    body.ratingScaleLabels !== undefined
  if (!hasSlots) return body
  const { ratingScaleMin, ratingScaleMax, ratingScaleLabels, ...rest } = body
  const scale: Record<string, unknown> = {}
  if (ratingScaleMin !== undefined) scale.min = ratingScaleMin
  if (ratingScaleMax !== undefined) scale.max = ratingScaleMax
  if (ratingScaleLabels !== undefined) scale.labels = ratingScaleLabels
  return { ...rest, ratingScale: scale }
}
