import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";

const scratchDataDir = mkdtempSync(join(tmpdir(), "openbooks-sftp-rmdir-"));
const { env } = await import("../platform/db.ts");
env.OPENBOOKS_DATA_DIR = scratchDataDir;

const { backendFor, s3Backend, setSftpS3ClientForTests, SftpDirectoryNotEmptyError } = await import("./backend.ts");
const { commandInput, createFakeS3 } = await import("./fake-s3.ts");

const ORG = "77777777-7777-7777-7777-777777777777";
const ROOT = `sftp/${ORG}/rmdir`;
const BUCKET = "openbooks";

test.after(() => {
  setSftpS3ClientForTests(null);
  rmSync(scratchDataDir, { recursive: true, force: true });
});

function s3BackendOverFake(): { backend: ReturnType<typeof s3Backend>; fake: ReturnType<typeof createFakeS3> } {
  const fake = createFakeS3();
  setSftpS3ClientForTests(fake.client);
  return { backend: s3Backend(BUCKET, ROOT, ORG), fake };
}

function put(fake: ReturnType<typeof createFakeS3>, key: string, bytes = "x"): void {
  fake.objects.set(`${ROOT}/${key}`, { bytes: Buffer.from(bytes), lastModified: new Date() });
}

function listProbes(fake: ReturnType<typeof createFakeS3>): { Prefix: string; MaxKeys: number }[] {
  return fake.sent
    .filter((command): command is ListObjectsV2Command => command instanceof ListObjectsV2Command)
    .map((command) => {
      const input = commandInput(command);
      return { Prefix: input["Prefix"] as string, MaxKeys: input["MaxKeys"] as number };
    });
}

test("S3 rmdir refuses a folder with a marker plus a child, naming it", async () => {
  const { backend, fake } = s3BackendOverFake();
  put(fake, "inbound/", "");
  put(fake, "inbound/statement.ofx", "statement");

  await assert.rejects(
    backend.rmdir("inbound"),
    (error: unknown) => {
      assert.ok(error instanceof SftpDirectoryNotEmptyError);
      assert.match((error as Error).message, /sftp folder '\/inbound' is not empty/);
      return true;
    },
  );
  // The marker is deleted only when empty: the refusal leaves everything.
  assert.ok(fake.objects.has(`${ROOT}/inbound/`), "the folder marker must survive a refused rmdir");
  assert.ok(fake.objects.has(`${ROOT}/inbound/statement.ofx`), "the child must survive a refused rmdir");
  // The emptiness probe lists the prefix for any child.
  assert.deepEqual(listProbes(fake), [{ Prefix: `${ROOT}/inbound/`, MaxKeys: 2 }]);
});

test("S3 rmdir refuses an implicit folder (no marker) holding a child", async () => {
  const { backend, fake } = s3BackendOverFake();
  put(fake, "inbound/statement.ofx", "statement");

  await assert.rejects(backend.rmdir("inbound"), SftpDirectoryNotEmptyError);
  assert.ok(fake.objects.has(`${ROOT}/inbound/statement.ofx`));
});

test("S3 rmdir removes an empty folder and drops its marker", async () => {
  const { backend, fake } = s3BackendOverFake();
  await backend.mkdir("empty");

  await backend.rmdir("empty");

  assert.equal(await backend.stat("empty"), null);
  assert.ok(!fake.objects.has(`${ROOT}/empty/`), "the marker is deleted only once the prefix is empty");
});

test("S3 rmdir of a never-created prefix succeeds without side effects", async () => {
  const { backend, fake } = s3BackendOverFake();
  await backend.rmdir("ghost");
  assert.equal(fake.objects.size, 0);
});

test("local rmdir refuses a non-empty directory by virtual name", async () => {
  const backend = backendFor({ orgId: ORG, backend: "local", bucket: null, rootPrefix: ROOT });
  await backend.write("populated/statement.ofx", Buffer.from("statement"));
  await assert.rejects(
    backend.rmdir("populated"),
    (error: unknown) => {
      assert.ok(error instanceof SftpDirectoryNotEmptyError);
      assert.match((error as Error).message, /sftp folder '\/populated' is not empty/);
      // The refusal names the virtual path — never the server absolute path.
      assert.doesNotMatch((error as Error).message, new RegExp(scratchDataDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    },
  );
  await backend.remove("populated/statement.ofx");
  await backend.rmdir("populated");
  assert.equal(await backend.stat("populated"), null);
});
