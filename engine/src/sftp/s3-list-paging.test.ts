import assert from "node:assert/strict";
import test from "node:test";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";

const { s3Backend, setSftpS3ClientForTests } = await import("./backend.ts");
const { commandInput, createFakeS3 } = await import("./fake-s3.ts");

const ORG = "f3000000-0000-0000-0000-000000000000";
const ROOT = `sftp/${ORG}/paging`;
const BUCKET = "paging-bucket";

test.after(() => {
  setSftpS3ClientForTests(null);
});

function listCalls(fake: ReturnType<typeof createFakeS3>): Record<string, unknown>[] {
  return fake.sent
    .filter((command): command is ListObjectsV2Command => command instanceof ListObjectsV2Command)
    .map((command) => commandInput(command));
}

test("an S3 listing past 1,000 keys follows every page for files and prefixes", async () => {
  const fake = createFakeS3();
  setSftpS3ClientForTests(fake.client);
  try {
    // Page 1 holds persistent failures or older files in production; without
    // continuation every key past it would stay unimported forever.
    for (let i = 0; i < 2500; i++) {
      const name = `f-${String(i).padStart(4, "0")}.ofx`;
      fake.objects.set(`${ROOT}/inbound/${name}`, { bytes: Buffer.from("statement"), lastModified: new Date() });
    }
    for (let i = 0; i < 1200; i++) {
      const dir = `shard-${String(i).padStart(4, "0")}`;
      fake.objects.set(`${ROOT}/${dir}/stmt.ofx`, { bytes: Buffer.from("statement"), lastModified: new Date() });
    }
    // Outside the tenant prefix: never visible to this backend, whatever page
    // they would fall on.
    fake.objects.set("sftp/other-org/evil.ofx", { bytes: Buffer.from("x"), lastModified: new Date() });
    fake.objects.set("elsewhere/y.ofx", { bytes: Buffer.from("x"), lastModified: new Date() });

    const backend = s3Backend(BUCKET, ROOT, ORG);

    // RED before the fix: list() issued ONE ListObjectsV2 and returned at
    // most 1,000 entries, silently dropping the other 1,500 files.
    const files = await backend.list("inbound");
    assert.equal(files.length, 2500, "every file across all pages must be visible");
    const names = new Set(files.map((entry) => entry.name));
    assert.ok(names.has("f-0000.ofx") && names.has("f-2499.ofx"));
    assert.ok(files.every((entry) => !entry.isDir));
    assert.ok(
      listCalls(fake).length >= 3,
      `2500 keys must take at least 3 pages (took ${listCalls(fake).length} ListObjectsV2 calls)`,
    );

    const root = await backend.list("/");
    const dirs = root.filter((entry) => entry.isDir).map((entry) => entry.name);
    assert.equal(dirs.length, 1201, "inbound plus all 1,200 shard prefixes must be visible across pages");
    assert.ok(dirs.includes("inbound") && dirs.includes("shard-0000") && dirs.includes("shard-1199"));

    const stray = [...names, ...dirs].filter((name) => name.includes("evil") || name.includes("elsewhere"));
    assert.deepEqual(stray, [], "keys outside the tenant prefix must never surface");
  } finally {
    setSftpS3ClientForTests(null);
  }
});
