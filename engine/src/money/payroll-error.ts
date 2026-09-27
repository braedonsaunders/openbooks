/**
 * The payroll module's base error, kept dependency-free for shared arithmetic.
 *
 * It lives here rather than in `payroll-run.ts` because of a real failure this
 * codebase hit three times. The payroll modules form import cycles by design —
 * `payroll-run.ts` calls into the opening-balance, entitlement and limit
 * services, and each of those raises payroll errors back — and a cycle is fine
 * for anything dereferenced inside a function body. `class X extends
 * PayrollError {}` is not: it is evaluated at MODULE-EVALUATION time, so
 * whichever module in the cycle happens to load second throws
 * `ReferenceError: Cannot access 'PayrollError' before initialization` and
 * takes down every test file and every request that reaches payroll at all.
 *
 * The symptom is maximally confusing — an unrelated file fails to import — and
 * the previous workaround was for each service to declare its own error
 * `extends Error`, which quietly broke the hierarchy that callers catch on.
 *
 * This module imports nothing, so it cannot create a module cycle. The
 * payroll module re-exports it, and the payroll decimal helpers use the same
 * constructor so existing error classification remains consistent.
 */
export class PayrollError extends Error {}
