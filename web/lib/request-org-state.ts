export interface RequestOrgScope {
  orgId: string | null;
  bypass: boolean;
}

type RequestOrgRuntime = typeof globalThis & {
  __openbooksRequestOrgByWorkStore?: WeakMap<object, RequestOrgScope>;
};

const runtime = globalThis as RequestOrgRuntime;

/**
 * Process-global because Next/Turbopack can evaluate the web module graph more
 * than once during development. Every copy of request-org.ts must write to the
 * same store that the engine's process-global resolver reads.
 */
export const requestOrgByWorkStore = runtime.__openbooksRequestOrgByWorkStore ??=
  new WeakMap<object, RequestOrgScope>();
