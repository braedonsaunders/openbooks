/**
 * One shared ceiling for the approvals bulk path. The bulk endpoint refuses
 * more items per request and the worklist caps its page size here, so a
 * page-scoped selection always fits a single bulk request. A single source
 * on purpose: two numbers would drift, and drift would turn select-all into
 * a whole-batch 400.
 */
export const APPROVALS_BULK_BATCH_MAX = 50
