import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The storage resolver reads its local data root from the engine env snapshot
// taken when db.ts first loads, so hand that snapshot a throwaway directory
// before importing the resolver (mirrors import-job.integration.test.ts).
const scratchDataDir = mkdtempSync(join(tmpdir(), "openbooks-sftp-backend-"));
const { env } = await import("../db.ts");
env.OPENBOOKS_DATA_DIR = scratchDataDir;

const { assertTenantRootPrefix, backendFor } = await import("./backend.ts");

const ORG = "11111111-1111-1111-1111-111111111111";
const VICTIM = "22222222-2222-2222-2222-222222222222";

test("a percent-encoded cross-tenant traversal prefix is refused by both physical resolvers", () => {
  // One representative attack: percent-encoding hiding a traversal, rooted in a
  // victim org's namespace — exactly the prefix an org admin used to be able to
  // store verbatim to read/write/delete another tenant's objects with the app's
  // own credentials (or to escape the local data root).
  const hostile = `sftp/${VICTIM}/..%2f..%2fescape`;

  assert.throws(
    () => assertTenantRootPrefix(hostile, ORG),
    /percent-encoding/,
    "the canonical validator must refuse the encoded traversal",
  );
  assert.throws(
    () => backendFor({ orgId: ORG, backend: "s3", bucket: "openbooks", rootPrefix: hostile }),
    /percent-encoding/,
    "the S3 resolver must refuse before any key is derived",
  );
  assert.throws(
    () => backendFor({ orgId: ORG, backend: "local", bucket: null, rootPrefix: hostile }),
    /percent-encoding/,
    "the local resolver must refuse before any filesystem operation",
  );

  // A syntactically clean cross-tenant prefix is refused just the same — the
  // shared bucket makes org-bounded containment, not only traversal, mandatory.
  assert.throws(
    () => assertTenantRootPrefix(`sftp/${VICTIM}/statements`, ORG),
    new RegExp(`must stay under sftp/${ORG}/`),
  );
  assert.throws(
    () => backendFor({ orgId: ORG, backend: "local", bucket: null, rootPrefix: `sftp/${VICTIM}/statements` }),
    new RegExp(`must stay under sftp/${ORG}/`),
    "the local physical resolver must enforce tenant binding, not only path shape",
  );
});

test("a valid tenant-relative control resolves under the tenant namespace and the local data root", () => {
  const rootPrefix = `sftp/${ORG}/feedbot`;

  // S3: contained inside the org's namespace (no network I/O at construction).
  const s3 = backendFor({ orgId: ORG, backend: "s3", bucket: "openbooks", rootPrefix });
  assert.equal(typeof s3.list, "function");

  // Local: a write through the resolved backend must land inside the tenant's
  // subfolder of the data root — never beside it, never above it.
  const local = backendFor({ orgId: ORG, backend: "local", bucket: null, rootPrefix });
  const fileOnDisk = join(scratchDataDir, "sftp", "sftp", ORG, "feedbot", "inbound", "note.txt");
  return local
    .write("inbound/note.txt", Buffer.from("contained"))
    .then(() => {
      assert.equal(existsSync(fileOnDisk), true, "the virtual root must resolve under the tenant subfolder");
      return local.read("inbound/note.txt");
    })
    .then((buf) => assert.equal(buf.toString("utf8"), "contained"))
    .finally(() => rmSync(join(scratchDataDir, "sftp"), { recursive: true, force: true }));
});
