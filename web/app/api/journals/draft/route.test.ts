import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

interface Call {
  orgId: string;
  userId: string;
  options: {
    subsidiaryId?: string | null;
    allowedSubsidiaryIds?: ReadonlySet<string> | null;
  };
}

const stateKey = Symbol.for("openbooks.journal-draft-route-test");
const state: {
  allowedSubsidiaryIds: Set<string> | null;
  calls: Call[];
} = {
  allowedSubsidiaryIds: null,
  calls: [],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

const ROOT_ID = "00000000-0000-4000-8000-000000000001";
const SINGLE_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_ID = "00000000-0000-4000-8000-000000000003";

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.journal-draft-route-test')]
      export async function guardPermission() {
        return {
          user: { orgId: 'org-1', id: 'user-1' },
          allowedSubsidiaryIds: state.allowedSubsidiaryIds,
        }
      }
    `,
  ],
  [
    "mock:journals",
    `
      const state = globalThis[Symbol.for('openbooks.journal-draft-route-test')]
      const legalIds = new Set([
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003',
      ])
      function refusal(code, message) {
        const error = new Error(message)
        error.code = code
        throw error
      }
      export async function createDraftJournal(orgId, userId, options = {}) {
        state.calls.push({ orgId, userId, options })
        const scope = options.allowedSubsidiaryIds === undefined ? null : options.allowedSubsidiaryIds
        let subsidiaryId = options.subsidiaryId ?? null
        if (subsidiaryId !== null) {
          if (scope !== null && !scope.has(subsidiaryId)) refusal('subsidiary_not_allowed', 'not found')
          if (!legalIds.has(subsidiaryId)) refusal('invalid_subsidiary', 'invalid subsidiary')
        } else if (scope !== null) {
          const available = [...scope].filter((id) => legalIds.has(id))
          if (available.length === 0) refusal('no_available_subsidiary', 'no available subsidiary')
          if (available.length !== 1) refusal('ambiguous_subsidiary_scope', 'ambiguous scope')
          subsidiaryId = available[0]
        } else {
          subsidiaryId = '00000000-0000-4000-8000-000000000001'
        }
        return { id: 'draft-' + subsidiaryId, documentNumber: 'JE-0001' }
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["../../../../lib/authz", "mock:authz"],
  ["../../../../lib/journals", "mock:journals"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined)
      return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?draft-scope-test";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

function reset(scope: Set<string> | null): void {
  state.allowedSubsidiaryIds = scope;
  state.calls.length = 0;
}

function request(body?: Record<string, unknown>): Request {
  return new Request("http://openbooks.test/api/journals/draft", {
    method: "POST",
    ...(body
      ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
}

test("restricted caller with one legal entity defaults to that entity", async () => {
  reset(new Set([SINGLE_ID]));

  const response = await POST(request());

  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, `draft-${SINGLE_ID}`);
  assert.equal(state.calls.length, 1);
  assert.equal(
    state.calls[0]!.options.allowedSubsidiaryIds?.has(SINGLE_ID),
    true,
  );
});

test("restricted caller with an empty scope fails closed without writing", async () => {
  reset(new Set());

  const response = await POST(request());

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "no_available_subsidiary" });
  assert.equal(state.calls.length, 0);
});

test("restricted caller with an ambiguous legal-entity scope must select explicitly", async () => {
  reset(new Set([SINGLE_ID, OTHER_ID]));

  const response = await POST(request());

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "subsidiary_selection_required",
  });
  assert.equal(state.calls.length, 1);
});

test("an explicit subsidiary outside the restricted scope is indistinguishable from missing", async () => {
  reset(new Set([SINGLE_ID]));

  const response = await POST(request({ subsidiaryId: OTHER_ID }));

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not found" });
  assert.equal(state.calls.length, 0);
});

test("unrestricted callers preserve root default and may select an explicit entity", async () => {
  reset(null);

  const defaultResponse = await POST(request());
  assert.equal(defaultResponse.status, 200);
  assert.equal((await defaultResponse.json()).id, `draft-${ROOT_ID}`);

  const explicitResponse = await POST(request({ subsidiaryId: OTHER_ID }));
  assert.equal(explicitResponse.status, 200);
  assert.equal((await explicitResponse.json()).id, `draft-${OTHER_ID}`);
});
