/**
 * The permission that gates writing a tax filing (prepare a snapshot, mark it
 * filed). Shared by the filings routes and the tax view so the UI offers the
 * actions exactly when the routes allow them. Lives outside the route files:
 * a Next route module may export only its handlers.
 */
export const TAX_FILING_WRITE_PERMISSION = 'compliance.file' as const
