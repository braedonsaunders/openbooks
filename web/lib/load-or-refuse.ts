import 'server-only'

/**
 * One shared mechanism for "a known domain refusal during page load renders
 * a refusal state": /time/clock (FieldTimeError no_employee_link) and the
 * /me loaders (SelfServiceError NO_LINK, Hrm* no-link REFUSED) all resolve
 * their actor through a person link, and an unlinked login must read the
 * refusal with its remedy — never the error boundary, which production
 * renders as generic copy with the real message hidden.
 *
 * Only the listed (error class, code) pairs convert; everything else still
 * throws, including other codes of the same classes. Converted messages are
 * about the caller only (no cross-tenant existence leaks), so carrying the
 * engine's own words into the page state is safe.
 */

export interface PageRefusal {
  title: string
  message: string
}

export interface KnownRefusal {
  error: new (...args: never[]) => Error
  code: string
  /**
   * Narrow a shared code to one refusal text. HrmDocumentsError and
   * HrmSurveysError both refuse as REFUSED; only the no-link text
   * ("... is not linked to a person record ...") converts — a grant
   * refusal from the same call still throws.
   */
  messageIncludes?: string
}

export type LoadOutcome<T> = { ok: true; data: T } | { ok: false; refusal: PageRefusal }

/** Run a page loader, converting only the listed refusals to page state. */
export async function loadOrRefuse<T>(
  load: () => Promise<T>,
  opts: { refusals: readonly KnownRefusal[]; title: string },
): Promise<LoadOutcome<T>> {
  try {
    return { ok: true, data: await load() }
  } catch (e) {
    const code = (e as { code?: unknown }).code
    for (const known of opts.refusals) {
      if (
        e instanceof known.error
        && code === known.code
        && (known.messageIncludes === undefined
          || (e instanceof Error && e.message.includes(known.messageIncludes)))
      ) {
        return {
          ok: false,
          refusal: { title: opts.title, message: e instanceof Error ? e.message : String(e) },
        }
      }
    }
    throw e
  }
}
