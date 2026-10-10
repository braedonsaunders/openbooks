import { PayrollError } from './error.ts';

/** Application code can become available before its controlled schema rollout. */
export class CompensationPackageUnavailableError extends PayrollError {
  constructor() { super('Compensation packages are unavailable on this server — ask an administrator to complete the server upgrade before configuring packages.'); }
}

/** Recognize only this feature's absent relations; unrelated database failures retain their meaning. */
export function compensationPackageSchemaRefusal(error: unknown): CompensationPackageUnavailableError | null {
  const visited = new Set<object>();
  let detail = error;
  while (detail && typeof detail === 'object' && !visited.has(detail)) {
    visited.add(detail);
    const cause = detail as { code?: string; message?: string; cause?: unknown };
    if (cause.code === '42P01' && /^relation "(?:public\.)?payroll_compensation_(?:configuration|packages|versions|assignments|calculations)" does not exist$/.test(cause.message ?? '')) return new CompensationPackageUnavailableError();
    if (cause.code === '42703' && /^column "submission_policy" of relation "payroll_compensation_(?:versions|assignments)" does not exist$/.test(cause.message ?? '')) return new CompensationPackageUnavailableError();
    detail = cause.cause;
  }
  return null;
}
