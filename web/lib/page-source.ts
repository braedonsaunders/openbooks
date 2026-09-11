import { existsSync, readFileSync } from 'node:fs'

/**
 * The source of a page — which is now TWO files.
 *
 * A long line of tests in this tree assert invariants by reading a page's
 * source: that it consults a feature gate, that it scopes a payroll query,
 * that it renders through the shared paper surface. Those assertions are
 * cheap, they have caught real regressions, and every one of them was written
 * when `page.tsx` held the whole page.
 *
 * The ViewSpec conversion moved the logic into a sibling `view.ts` and left
 * `page.tsx` as four lines of wiring. That did not weaken any invariant — the
 * gate is still there, one file over — but it did make every one of those
 * greps stop looking where the code is. A grep that reads the wrong file does
 * not fail loudly the way these did; it would have started passing vacuously
 * if the assertions had been `doesNotMatch`, and several of them are.
 *
 * So "the source of a page" means the pair, concatenated. A test written
 * against either arrangement keeps working, and a gate can move between the
 * two files without anyone having to remember to update a test.
 */
export function pageSource(path: string): string {
  const parts = [readFileSync(path, 'utf8')]
  const view = path.replace(/page\.tsx$/, 'view.ts')
  // Not every page has one: nine routes are bare redirects, and a handful of
  // pages predate the split. A missing sibling is normal, not an error.
  if (view !== path && existsSync(view)) parts.push(readFileSync(view, 'utf8'))
  return parts.join('\n')
}

/**
 * Wrap an existing `readFileSync`-style reader so that reading a `page.tsx`
 * transparently reads its `view.ts` too.
 *
 * Exists so the repair to each of these tests is one line at the reader rather
 * than an edit at every call site — there are well over a hundred, and a
 * per-call-site fix is one someone forgets on the next page they add.
 */
export function readingPagePairs(read: (path: string) => string): (path: string) => string {
  return (path: string) => {
    if (!path.endsWith('page.tsx')) return read(path)
    const view = path.replace(/page\.tsx$/, 'view.ts')
    try {
      return `${read(path)}\n${read(view)}`
    } catch {
      return read(path)
    }
  }
}
