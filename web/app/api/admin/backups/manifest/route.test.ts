import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// The manifest is a JSON sidecar of the stored archive, not a relabel of the
// archive itself: downloading it must serve manifest bytes under a distinct
// *.manifest.json filename (passing `${base}.json.gz` as the helper stem
// once relabeled the manifest with the archive name). The real filename
// helper builds the header; the route must hand it the stripped archive base
// with the manifest suffix.

const ORG_ID = "00000000-0000-4000-8000-000000000051";
const USER_ID = "00000000-0000-4000-8000-000000000052";
const RUN_ID = "00000000-0000-4000-8000-000000000053";

interface ManifestState {
  run: Record<string, unknown> | null;
  queries: number;
  audits: unknown[];
}

const stateKey = Symbol.for("openbooks.backup-manifest-route-test");
const routeState: ManifestState = { run: null, queries: 0, audits: [] };
(globalThis as Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      export async function guardPermission() {
        return { user: { id: '${USER_ID}', orgId: '${ORG_ID}' } }
      }
    `,
  ],
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.backup-manifest-route-test')]
      export const db = {
        execute: async () => {
          state.queries += 1
          return { rows: state.run ? [state.run] : [] }
        },
      }
    `,
  ],
  [
    "mock:backup",
    `
      const state = globalThis[Symbol.for('openbooks.backup-manifest-route-test')]
      export async function auditBackupEvent(event) {
        state.audits.push(event)
      }
    `,
  ],
]);

const listParamsUrl = new URL("../../../../../lib/list-params.ts", import.meta.url).href;

const mockUrls = new Map<string, string>([
  ["../../../../../../lib/authz", "mock:authz"],
  ["@openbooks/engine/src/platform/db.ts", "mock:db"],
  ["@openbooks/engine/src/backup/backup.ts", "mock:backup"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    }
    if (specifier === "../../../../../../lib/list-params") {
      return nextResolve(listParamsUrl, context);
    }
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) {
      return { format: "module", source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "../[id]/manifest/route.ts?backup-manifest";
const { GET } = (await import(routeUrl)) as typeof import(
  "../[id]/manifest/route.ts"
);
hooks.deregister();

function reset(run: Record<string, unknown> | null): void {
  routeState.run = run;
  routeState.queries = 0;
  routeState.audits = [];
}

function completedRun(): Record<string, unknown> {
  return {
    id: RUN_ID,
    org_id: ORG_ID,
    file_name: "acme-backup.json.gz",
    status: "completed",
    purged_at: null,
    sha256: "abc123",
    byte_size: "10",
    table_count: 3,
    row_count: "5",
    created_at: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function getRequest(id: string): { req: Request; ctx: { params: Promise<{ id: string }> } } {
  return {
    req: new Request(`http://openbooks.test/api/admin/backups/${id}/manifest`, { method: "GET" }),
    ctx: { params: Promise.resolve({ id }) },
  };
}

test("manifest downloads use a distinct JSON sidecar filename", async () => {
  reset(completedRun());
  const { req, ctx } = getRequest(RUN_ID);

  const response = await GET(req, ctx);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1];
  assert.equal(filename, "acme-backup.manifest.json");
  assert.notEqual(filename, "acme-backup.json.gz");
  const body = (await response.json()) as { file?: string; sha256?: string };
  assert.equal(body.file, "acme-backup.json.gz");
  assert.equal(body.sha256, "abc123");
  assert.deepEqual(routeState.audits, [
    {
      orgId: ORG_ID,
      tableName: "backup_runs",
      rowId: RUN_ID,
      actorId: USER_ID,
      changes: { event: "backup_manifest_download", sha256: "abc123" },
    },
  ]);
});

test("manifest refuses a malformed backup id without touching the database", async () => {
  reset(completedRun());
  const { req, ctx } = getRequest("nope");

  const response = await GET(req, ctx);

  assert.equal(response.status, 404);
  assert.equal(routeState.queries, 0);
  assert.deepEqual(routeState.audits, []);
});

test("manifest reports a missing run as not found", async () => {
  reset(null);
  const { req, ctx } = getRequest(RUN_ID);

  const response = await GET(req, ctx);

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "backup not found" });
  assert.deepEqual(routeState.audits, []);
});
