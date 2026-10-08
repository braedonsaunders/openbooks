/**
 * Which pulse sections the caller may see. The pulse is a combined payload
 * across domains, so one read permission cannot unlock all of it:
 *
 *   - `ar` covers receivables telemetry (aging, credit terms and headroom,
 *     payment history) and every commercial-document timeline entry
 *     (quotes, sales orders, invoices, payments) — the same `ar.read` the
 *     standalone statement and order surfaces require.
 *   - `crm` covers the relationship side (opportunity pipeline, activity
 *     timeline) — the `crm.accounts.read` the account drawer requires.
 *   - `projects` covers the delivery rollup — `projects.read`.
 *
 * Subsidiary/record scope inside each section is the same scope helper the
 * standalone endpoint for that section enforces; gating here never re-derives
 * it. Sections the caller cannot see are OMITTED from the payload — never
 * nulled with data-shaped defaults, which would read as genuine zeros.
 */
export interface CustomerPulseSections {
  ar: boolean
  crm: boolean
  projects: boolean
}

/**
 * Map effective permissions to pulse sections. Returns null when the caller
 * may see nothing at all — the route turns that into a 403 naming the
 * permissions that would grant access.
 */
export function pulseSectionsFor(
  covers: (permission: string) => boolean,
): CustomerPulseSections | null {
  const sections: CustomerPulseSections = {
    ar: covers('ar.read'),
    crm: covers('crm.accounts.read'),
    projects: covers('projects.read'),
  }
  if (!sections.ar && !sections.crm && !sections.projects) return null
  return sections
}

