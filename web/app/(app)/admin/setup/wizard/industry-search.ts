import { featureSearchMatcher } from '../features/feature-tree'

/**
 * Industry picker search. Each preset is found by its localized title and
 * description and by its localized keywords — the everyday words an operator
 * uses for a business the preset fits ("café", "retail", "e-commerce",
 * "coffee roaster"). Matching folds case and accents and requires every term,
 * the same rules as the Features switchboard search.
 *
 * Results keep registry order, with presets matched on their own title or
 * description ahead of those matched only through a keyword.
 */
export function searchIndustries<T extends { key: string }>(
  industries: readonly T[],
  query: string,
  copy: (key: string) => { title: string; description: string; keywords: string },
): T[] {
  const direct = featureSearchMatcher<T>(query, (industry) => {
    const text = copy(industry.key)
    return [text.title, text.description]
  })
  if (!direct) return [...industries]
  const anyText = featureSearchMatcher<T>(query, (industry) => {
    const text = copy(industry.key)
    return [text.title, text.description, text.keywords]
  })!
  const named = industries.filter(direct)
  const related = industries.filter((industry) => !direct(industry) && anyText(industry))
  return [...named, ...related]
}
