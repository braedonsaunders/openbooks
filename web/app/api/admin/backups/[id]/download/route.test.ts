import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { registerHooks } from "node:module";
import test from "node:test";

const ORG_ID = "00000000-0000-4000-8000-000000000061";
const USER_ID = "00000000-0000-4000-8000-000000000062";
const RUN_ID = "00000000-0000-4000-8000-000000000063";
const archiveBytes = Buffer.from("backup archive bytes");
const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");

interface DownloadState {
  run: Record<string, unknown> | null;
  queries: number;
  audits: unknown[];
  auditGate?: Promise<void>;
  storageReads: number;
  object: { Body: Readable; ContentLength: number; Metadata: { sha256: string } } | null;
}

const state: DownloadState = {
  run: null,
  queries: 0,
  audits: [],
  storageReads: 0,
  object: null,
};
const stateKey = Symbol.for("openbooks.stored-backup-download-route-test");
(globalThis as Record<symbol, unknown>)[stateKey] = state;

const mockSources = new Map<string, string>([
  ["mock:authz", `export async function guardPermission() { return { user: { id: '${USER_ID}', orgId: '${ORG_ID}' } } }`],
  ["mock:db", `
    const state = globalThis[Symbol.for('openbooks.stored-backup-download-route-test')]
    export const db = { execute: async () => { state.queries += 1; return { rows: state.run ? [state.run] : [] } } }
  `],
  ["mock:backup", `
    const state = globalThis[Symbol.for('openbooks.stored-backup-download-route-test')]
    export async function auditBackupEvent(event) {
      state.audits.push(event)
      if (state.auditGate) await state.auditGate
    }
    export async function getBackupObject(key) {
      state.storageReads += 1
      state.lastKey = key
      return state.object
    }
  `],
]);

const listParamsUrl = new URL("../../../../../../lib/list-params.ts", import.meta.url).href;
const exportUrl = new URL("../../../../../../lib/export.ts", import.meta.url).href;
const mockUrls = new Map([
  ["../../../../../../lib/authz", "mock:authz"],
  ["@openbooks/engine/src/platform/db.ts", "mock:db"],
  ["@openbooks/engine/src/backup/backup.ts", "mock:backup"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    if (specifier === "../../../../../../lib/list-params") return nextResolve(listParamsUrl, context);
    if (specifier === "../../../../../../lib/export") return nextResolve(exportUrl, context);
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?stored-backup-download";
const { GET } = await import(routeUrl) as typeof import("./route.ts");
hooks.deregister();

function reset(run = completedRun(), sha256 = archiveSha256) {
  state.run = run;
  state.queries = 0;
  state.audits = [];
  state.auditGate = undefined;
  state.storageReads = 0;
  state.object = {
    Body: Readable.from([archiveBytes]),
    ContentLength: archiveBytes.byteLength,
    Metadata: { sha256 },
  };
}

function completedRun(): Record<string, unknown> {
  return {
    id: RUN_ID,
    file_name: "acme-backup.json.gz",
    object_key: `backups/${ORG_ID}/${RUN_ID}.json.gz`,
    status: "completed",
    purged_at: null,
    sha256: archiveSha256,
    byte_size: String(archiveBytes.byteLength),
  };
}

function getRequest(id: string) {
  return {
    req: new Request(`http://openbooks.test/api/admin/backups/${id}/download`, { method: "GET" }),
    ctx: { params: Promise.resolve({ id }) },
  };
}

test("stored download waits for evidence, verifies the archived bytes, and serves their digest", async () => {
  reset();
  let releaseAudit!: () => void;
  state.auditGate = new Promise<void>((resolve) => { releaseAudit = resolve; });
  const { req, ctx } = getRequest(RUN_ID);
  let settled = false;
  const responsePromise = GET(req, ctx).then((response) => {
    settled = true;
    return response;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(state.audits.length, 1, "the disclosure attempt precedes storage access");
    assert.equal(state.storageReads, 0);
    assert.equal(settled, false, "the archive cannot be disclosed before the audit write completes");
  } finally {
    releaseAudit();
  }
  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.equal(state.storageReads, 1);
  assert.equal(await response.text(), archiveBytes.toString());
  assert.equal(response.headers.get("Content-Length"), String(archiveBytes.byteLength));
  assert.equal(response.headers.get("X-OpenBooks-SHA256"), archiveSha256);
  assert.equal(
    response.headers.get("Content-Digest"),
    `sha-256=:${Buffer.from(archiveSha256, "hex").toString("base64")}:`,
  );
});

test("stored download refuses object bytes whose recorded size differs", async () => {
  reset();
  state.object!.ContentLength += 1;
  const { req, ctx } = getRequest(RUN_ID);

  const response = await GET(req, ctx);

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "backup object failed integrity metadata validation" });
});
