import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// C-74: the attach and detach UPDATEs never checked rowCount, so a form row
// vanishing between the existence select and the UPDATE (or an RLS zero
// match) still audited, and POST answered {ok, fileId} with an orphan file
// and no linkage while DELETE answered ok for a no-op. Both verbs now lock
// the row, verify the write by rowCount, audit only the verified write, and
// answer a named 404 — with the orphan cleaned up — on zero rows.
const stateKey = Symbol.for("openbooks.tax-official-pdf-route-test");
interface RouteState {
  /** Row the existence select sees (pre-race). */
  formRow: { id: string; official_pdf_file_id: string | null } | null;
  /** Row the locked in-transaction select sees (post-race). */
  lockedRow: { id: string; official_pdf_file_id: string | null } | null;
  /** rowCount the in-transaction UPDATE reports. */
  updateRowCount: number;
  auditInserts: string[];
  createdFiles: string[];
  deletedFiles: string[];
}
const routeState: RouteState = {
  formRow: null,
  lockedRow: null,
  updateRowCount: 1,
  auditInserts: [],
  createdFiles: [],
  deletedFiles: [],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  routeState;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      export async function guardPermission(permission) {
        if (permission !== 'admin.setup.manage') {
          throw new Error('unexpected permission gate: ' + permission)
        }
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: null }
      }
    `,
  ],
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.tax-official-pdf-route-test')]
      const sqlText = (query) => {
        const chunks = query?.queryChunks
        if (!Array.isArray(chunks)) return ''
        return chunks
          .map((c) => {
            if (typeof c === 'string') return c
            if (Array.isArray(c?.value)) return c.value.map(String).join('')
            if (c?.queryChunks) return sqlText(c)
            return ''
          })
          .join('')
      }
      const tx = {
        async execute(query) {
          const text = sqlText(query)
          if (text.includes('for update')) return { rows: state.lockedRow ? [state.lockedRow] : [] }
          if (text.includes('update tax_return_forms')) return { rows: [], rowCount: state.updateRowCount }
          if (text.includes('insert into audit_log')) {
            state.auditInserts.push(text)
            return { rows: [] }
          }
          throw new Error('unexpected tx query: ' + text.slice(0, 80))
        },
      }
      export const db = {
        async execute(query) {
          const text = sqlText(query)
          if (text.includes('from tax_return_forms')) {
            return { rows: state.formRow ? [state.formRow] : [] }
          }
          throw new Error('unexpected database query: ' + text.slice(0, 80))
        },
        async transaction(work) { return work(tx) },
      }
    `,
  ],
  [
    "mock:file-cabinet",
    `
      const state = globalThis[Symbol.for('openbooks.tax-official-pdf-route-test')]
      export async function ensureAttachmentsRoot() { return 'root-1' }
      export async function createFile() {
        state.createdFiles.push('new-file-1')
        return { id: 'new-file-1' }
      }
      export async function deleteFile(orgId, fileId) {
        state.deletedFiles.push(fileId)
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["../../../../../../lib/authz", "mock:authz"],
  ["@openbooks/engine/src/platform/db.ts", "mock:db"],
  ["../../../../../../lib/file-cabinet", "mock:file-cabinet"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
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

const { POST, DELETE } = (await import("./route.ts")) as typeof import("./route.ts");
hooks.deregister();

function reset(state: Partial<RouteState>): void {
  routeState.formRow = state.formRow ?? null;
  routeState.lockedRow = state.lockedRow ?? null;
  routeState.updateRowCount = state.updateRowCount ?? 1;
  routeState.auditInserts.length = 0;
  routeState.createdFiles.length = 0;
  routeState.deletedFiles.length = 0;
}

function postPdf(): Promise<Response> {
  const form = new FormData();
  form.set("file", new File(["%PDF-1.7 probe"], "ST-100.pdf", { type: "application/pdf" }));
  return POST(
    new Request("http://openbooks.test/api/tax/returns/US_NY_ST100/official-pdf", {
      method: "POST",
      body: form,
    }),
    { params: Promise.resolve({ code: "US_NY_ST100" }) },
  ) as Promise<Response>;
}

function del(): Promise<Response> {
  return DELETE(
    new Request("http://openbooks.test/api/tax/returns/US_NY_ST100/official-pdf", { method: "DELETE" }),
    { params: Promise.resolve({ code: "US_NY_ST100" }) },
  ) as Promise<Response>;
}

test("POST links, audits, and retires the replaced file", async () => {
  reset({
    formRow: { id: "form-1", official_pdf_file_id: "old-file-1" },
    lockedRow: { id: "form-1", official_pdf_file_id: "old-file-1" },
  });

  const response = await postPdf();

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, fileId: "new-file-1" });
  assert.equal(routeState.auditInserts.length, 1);
  assert.deepEqual(routeState.deletedFiles, ["old-file-1"]);
});

test("POST answers 404 with no audit and cleans up the orphan when the row vanishes mid-write", async () => {
  reset({
    formRow: { id: "form-1", official_pdf_file_id: null },
    lockedRow: { id: "form-1", official_pdf_file_id: null },
    updateRowCount: 0,
  });

  const response = await postPdf();

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "tax return form not found" });
  assert.equal(routeState.auditInserts.length, 0);
  // The uploaded bytes were stored before the linkage failed: the orphan
  // must not linger in the cabinet.
  assert.deepEqual(routeState.deletedFiles, ["new-file-1"]);
});

test("DELETE unlinks, audits, and removes the file", async () => {
  reset({
    formRow: { id: "form-1", official_pdf_file_id: "old-file-1" },
    lockedRow: { id: "form-1", official_pdf_file_id: "old-file-1" },
  });

  const response = await del();

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(routeState.auditInserts.length, 1);
  assert.deepEqual(routeState.deletedFiles, ["old-file-1"]);
});

test("DELETE answers 404 with no audit and no file removal when nothing is attached", async () => {
  reset({
    formRow: { id: "form-1", official_pdf_file_id: null },
    lockedRow: { id: "form-1", official_pdf_file_id: null },
  });

  const response = await del();

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "no official PDF is attached to this return form" });
  assert.equal(routeState.auditInserts.length, 0);
  assert.deepEqual(routeState.deletedFiles, []);
});
