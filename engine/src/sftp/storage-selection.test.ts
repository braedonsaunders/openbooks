import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Storage selection reads process.env live with the engine env snapshot as
// fallback, so every test below pins all five variables in BOTH places and
// restores them afterwards — nothing may leak between tests.
const { env } = await import("../platform/db.ts");
const {
  appBucket,
  appStorageKind,
  assertSftpStorageReady,
  backendFor,
  sftpStorageSelection,
} = await import("./backend.ts");

const ORG = "44444444-4444-4444-4444-444444444444";
const ROOT = `sftp/${ORG}/storage-selection`;

const VARS = ["S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET", "OPENBOOKS_DATA_DIR"] as const;
type Var = (typeof VARS)[number];

function readVar(name: Var): string | undefined {
  return process.env[name] ?? (env as Record<string, string | undefined>)[name];
}

function setStorageEnv(values: Partial<Record<Var, string | undefined>>, clearOthers = true): void {
  for (const name of VARS) {
    const value = Object.hasOwn(values, name) ? values[name] : clearOthers ? undefined : readVar(name);
    if (value === undefined) {
      delete process.env[name];
      delete (env as Record<string, string | undefined>)[name];
    } else {
      process.env[name] = value;
      (env as Record<string, string>)[name] = value;
    }
  }
}

const saved = Object.fromEntries(VARS.map((name) => [name, readVar(name)])) as Partial<Record<Var, string | undefined>>;
test.after(() => setStorageEnv(saved, false));

const FULL_S3: Record<Var, string> = {
  S3_ENDPOINT: "http://localhost:9000",
  S3_ACCESS_KEY_ID: "openbooks",
  S3_SECRET_ACCESS_KEY: "replace-me",
  S3_BUCKET: "openbooks",
  OPENBOOKS_DATA_DIR: "/tmp/openbooks-sftp-storage-selection",
};

test("local storage without any configured root refuses by name instead of a per-process directory", () => {
  setStorageEnv({});
  assert.throws(() => sftpStorageSelection(), /Local SFTP storage needs OPENBOOKS_DATA_DIR/);
  assert.throws(() => appStorageKind(), /Local SFTP storage needs OPENBOOKS_DATA_DIR/);
  assert.throws(() => appBucket(), /Local SFTP storage needs OPENBOOKS_DATA_DIR/);
  assert.throws(() => assertSftpStorageReady(), /Local SFTP storage needs OPENBOOKS_DATA_DIR/);
  // A stored local row refuses at resolution too — the listener session and
  // the scheduled import both resolve through backendFor.
  assert.throws(
    () => backendFor({ orgId: ORG, backend: "local", bucket: null, rootPrefix: ROOT }),
    /Local SFTP storage needs OPENBOOKS_DATA_DIR set to an absolute directory shared by the web and worker processes, or configure S3/,
  );
});

test("local storage with a relative root refuses by name", () => {
  setStorageEnv({ OPENBOOKS_DATA_DIR: "relative/data" });
  assert.throws(() => sftpStorageSelection(), /absolute directory shared by the web and worker processes.*relative\/data/);
  assert.throws(
    () => backendFor({ orgId: ORG, backend: "local", bucket: null, rootPrefix: ROOT }),
    /absolute/,
  );
});

test("partial S3 configuration refuses by name, naming the missing variable", () => {
  const { S3_SECRET_ACCESS_KEY: _dropped, ...rest } = FULL_S3;
  setStorageEnv({ ...rest, OPENBOOKS_DATA_DIR: undefined });
  assert.throws(
    () => sftpStorageSelection(),
    /S3 is partly configured: S3_SECRET_ACCESS_KEY is missing/,
  );
  assert.throws(() => appStorageKind(), /S3 is partly configured: S3_SECRET_ACCESS_KEY is missing/);
  // An S3-rooted login refuses at resolution under partial config — never a
  // silent local fallback for an S3 row.
  assert.throws(
    () => backendFor({ orgId: ORG, backend: "s3", bucket: "openbooks", rootPrefix: ROOT }),
    /S3 is partly configured: S3_SECRET_ACCESS_KEY is missing/,
  );
});

test("a single missing endpoint with the other S3 variables present refuses by name", () => {
  const { S3_ENDPOINT: _dropped, ...rest } = FULL_S3;
  setStorageEnv({ ...rest, OPENBOOKS_DATA_DIR: undefined });
  assert.throws(() => sftpStorageSelection(), /S3 is partly configured: S3_ENDPOINT is missing/);
});

test("full S3 configuration selects object storage", () => {
  const { OPENBOOKS_DATA_DIR: _ignored, ...s3 } = FULL_S3;
  setStorageEnv(s3);
  assert.deepEqual(sftpStorageSelection(), { kind: "s3", bucket: "openbooks" });
  assert.equal(appStorageKind(), "s3");
  assert.equal(appBucket(), "openbooks");
});

test("an absolute shared root selects local storage with no S3 variables set", () => {
  const scratch = mkdtempSync(join(tmpdir(), "openbooks-sftp-selection-"));
  try {
    setStorageEnv({ OPENBOOKS_DATA_DIR: scratch });
    assert.deepEqual(sftpStorageSelection(), { kind: "local", bucket: null });
    assert.equal(appStorageKind(), "local");
    assert.equal(appBucket(), null);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("two processes with different working directories share one absolute root", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "openbooks-sftp-shared-root-"));
  const cwdA = mkdtempSync(join(tmpdir(), "openbooks-sftp-cwd-a-"));
  const cwdB = mkdtempSync(join(tmpdir(), "openbooks-sftp-cwd-b-"));
  const previousCwd = process.cwd();
  try {
    setStorageEnv({ OPENBOOKS_DATA_DIR: scratch });
    // The web listener's working directory: a partner upload lands here.
    process.chdir(cwdA);
    const listenerSide = backendFor({ orgId: ORG, backend: "local", bucket: null, rootPrefix: ROOT });
    await listenerSide.write("inbound/shared.ofx", Buffer.from("shared-bytes"));
    // The worker's working directory: the scheduled import must see it.
    process.chdir(cwdB);
    const workerSide = backendFor({ orgId: ORG, backend: "local", bucket: null, rootPrefix: ROOT });
    assert.equal((await workerSide.read("inbound/shared.ofx")).toString("utf8"), "shared-bytes");
    // RED before the fix: each side fell back to process.cwd()/.sftp-data, so
    // the worker saw zero files. No per-process fallback may exist anymore.
    assert.equal(existsSync(join(cwdA, ".sftp-data")), false);
    assert.equal(existsSync(join(cwdB, ".sftp-data")), false);
  } finally {
    process.chdir(previousCwd);
    rmSync(scratch, { recursive: true, force: true });
    rmSync(cwdA, { recursive: true, force: true });
    rmSync(cwdB, { recursive: true, force: true });
  }
});
