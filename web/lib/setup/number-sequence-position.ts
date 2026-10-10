/**
 * Operator-facing "next number" for document-number sequences.
 *
 * Storage keeps the number a sequence issued most recently
 * (`number_sequences.next_number`, 0 before the first issue) because every
 * allocator advances the row with one `next_number + 1` upsert under the row
 * lock. Setup speaks in the operator's terms instead — the number the next
 * document receives — so reads add one and writes subtract one, here and
 * nowhere else. A configured "Next number 2089" therefore issues 2089.
 */

/** Read projection for the number-sequences setup entity: the next number to issue. */
export const NUMBER_SEQUENCE_READ_COLUMNS = [
  'id', 'org_id', 'document_kind', 'subsidiary_id', 'prefix',
  '(next_number + 1) as next_number', 'padding', 'gapless', 'allocated_through',
  'created_at', 'created_by', 'updated_at', 'updated_by',
] as const

/** Map a requested read column to its projection (next_number becomes the next number to issue). */
export function numberSequenceReadColumn(column: string): string {
  return column === 'next_number' ? '(next_number + 1) as next_number' : column
}

/**
 * The stored position for an operator's next number, or a refusal naming the
 * remedy. `allocatedThrough` is the sequence's watermark (0 when nothing has
 * been issued); the next number must lie beyond it.
 */
export function storedSequencePosition(
  nextNumber: unknown,
  allocatedThrough: number,
): { value: number } | { error: string } {
  const next = typeof nextNumber === 'number' ? nextNumber : Number.NaN
  if (!Number.isSafeInteger(next) || next < 1) {
    return { error: 'Next number must be a whole number of 1 or more' }
  }
  if (allocatedThrough > 0 && next <= allocatedThrough) {
    return {
      error: `This sequence has already issued numbers through ${allocatedThrough}; set the next number to ${allocatedThrough + 1} or higher`,
    }
  }
  return { value: next - 1 }
}
