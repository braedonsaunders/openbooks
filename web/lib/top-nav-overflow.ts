/**
 * Return the number of leading top-navigation groups that fit before the
 * overflow menu. All measurements are CSS pixels from the rendered controls.
 */
export function visibleTopNavGroupCount({
  availableWidth,
  groupWidths,
  moreWidth,
  gap,
}: {
  availableWidth: number
  groupWidths: number[]
  moreWidth: number
  gap: number
}): number {
  const available = finiteNonNegative(availableWidth)
  const widths = groupWidths.map(finiteNonNegative)
  const itemGap = finiteNonNegative(gap)

  if (widths.length === 0) return 0

  const allGroupsWidth = widths.reduce((sum, width) => sum + width, 0) + itemGap * (widths.length - 1)
  if (allGroupsWidth <= available) return widths.length

  // Once anything overflows, reserve a gap and the More trigger. Keeping a
  // leading prefix makes the navigation order stable as the header resizes.
  const availableForGroups = Math.max(0, available - finiteNonNegative(moreWidth) - itemGap)
  let used = 0
  let visible = 0

  for (const width of widths) {
    const next = used + (visible > 0 ? itemGap : 0) + width
    if (next > availableForGroups) break
    used = next
    visible += 1
  }

  return visible
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}
