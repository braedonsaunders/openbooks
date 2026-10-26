/**
 * The approvals home. Every decision waiting on the signed-in operator is
 * listed in the Inbox (navigation module `approvals`), so links that ask
 * someone to decide point here rather than at a module-specific page.
 * Pure constants: client components, server views and engine read models
 * all share this one address.
 */
export const APPROVALS_HOME_HREF = "/inbox";

/** The Inbox view of the operator's own submissions still under review. */
export const APPROVALS_SUBMITTED_HREF = `${APPROVALS_HOME_HREF}?tab=submitted`;
