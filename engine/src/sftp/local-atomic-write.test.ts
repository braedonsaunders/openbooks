import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ssh2 from "ssh2";

// The local backend resolves its data root from the engine env snapshot
// taken when db.ts first loads — hand it a throwaway directory first.
const scratchDataDir = mkdtempSync(join(tmpdir(), "openbooks-sftp-atomic-"));
const { env } = await import("../platform/db.ts");
env.OPENBOOKS_DATA_DIR = scratchDataDir;

const { backendFor, isSftpTempName, SFTP_TEMP_WRITE_MARKER } = await import("./backend.ts");
const { generateHostKey, startSftpServer } = await import("./server.ts");

const ORG = "33333333-3333-3333-3333-333333333333";
const ROOT = `sftp/${ORG}/atomic`;

function backend() {
  return backendFor({ orgId: ORG, backend: "local", bucket: null, rootPrefix: ROOT });
}

function rawDir(): string {
  return join(scratchDataDir, "sftp", ROOT);
}

function tempNamesOnDisk(): string[] {
  return readdirSync(rawDir()).filter((n) => n.includes(SFTP_TEMP_WRITE_MARKER));
}

test("only the temp pattern is hidden — ordinary files and dotfiles are untouched", () => {
  assert.equal(isSftpTempName(`.statement.ofx${SFTP_TEMP_WRITE_MARKER}1-abc`), true);
  assert.equal(isSftpTempName(`outbound/.statement.ofx${SFTP_TEMP_WRITE_MARKER}1-abc`), true);
  assert.equal(isSftpTempName("statement.ofx"), false);
  assert.equal(isSftpTempName(".profile"), false);
  assert.equal(isSftpTempName(".processed"), false);
});

test("concurrent readers never observe a partially written file", async () => {
  const be = backend();
  const before = Buffer.alloc(2 * 1024 * 1024, "A");
  const after = Buffer.alloc(2 * 1024 * 1024, "B");
  await be.write("outbound/big.bin", before);

  let partial = 0;
  let reads = 0;
  let stop = false;
  const reader = (async () => {
    while (!stop) {
      const buf = await be.read("outbound/big.bin");
      reads++;
      if (!buf.equals(before) && !buf.equals(after)) partial++;
    }
  })();
  const readers = Array.from({ length: 8 }, () => reader.then(() => {}));
  // Publish several generations while the readers poll: every observation
  // must be exactly one complete generation. RED before the fix: the write
  // truncated the visible path first, so readers caught short buffers.
  for (let i = 0; i < 4; i++) {
    await be.write("outbound/big.bin", i % 2 === 0 ? after : before);
  }
  stop = true;
  await Promise.all(readers);
  assert.ok(reads > 0, "readers must have observed the file while it was published");
  assert.equal(partial, 0, `readers observed ${partial} partial files out of ${reads} reads`);
});

test("a successful publish leaves no temp sibling behind", async () => {
  const be = backend();
  await be.write("outbound/clean.bin", Buffer.from("complete"));
  assert.deepEqual(tempNamesOnDisk(), []);
  assert.deepEqual((await be.list("outbound")).map((e) => e.name).sort(), ["big.bin", "clean.bin"]);
});

test("a failed publish removes its temp sibling and still throws", async () => {
  const be = backend();
  // Plant a regular file where a directory must be: creating the temp
  // sibling underneath it fails, exercising the failure cleanup.
  await be.write("blocker", Buffer.from("in the way"));
  await assert.rejects(be.write("blocker/child.bin", Buffer.from("never visible")));
  assert.deepEqual(tempNamesOnDisk(), [], "the failed write must not leave its temp behind");
  assert.equal(await be.stat("blocker/child.bin"), null);
});

test("the SFTP daemon hides an in-flight publish from bank clients", async () => {
  // Own folder: earlier tests publish into outbound/ on the same backend root.
  mkdirSync(join(rawDir(), "outbound-bank"), { recursive: true });
  writeFileSync(join(rawDir(), "outbound-bank", "payment.xml"), Buffer.from("<complete/>"));
  // Simulate a publish caught mid-write: temp bytes on disk, final name untouched.
  const tempName = `.payment.xml${SFTP_TEMP_WRITE_MARKER}999-deadbeef`;
  writeFileSync(join(rawDir(), "outbound-bank", tempName), Buffer.from("<trunc"));

  const config = { id: "atomic-test", orgId: ORG, username: "atomic-bank", backend: "local", bucket: null as null, rootPrefix: ROOT };
  const server = await startSftpServer({
    port: 0,
    hostKey: generateHostKey(),
    resolve: { password: async (u, p) => (u === "atomic-bank" && p === "secret" ? config : null) },
  });
  try {
    const client = await new Promise<ssh2.Client>((resolve, reject) => {
      const c = new ssh2.Client();
      c.on("error", reject);
      c.once("ready", () => resolve(c));
      c.connect({ host: "127.0.0.1", port: server.port, username: "atomic-bank", password: "secret", hostVerifier: () => true });
    });
    try {
      const sftp = await new Promise<ssh2.SFTPWrapper>((resolve, reject) => {
        client.sftp((e, s) => (e ? reject(e) : resolve(s)));
      });
      const listed = await new Promise<ssh2.FileEntry[]>((resolve, reject) => {
        sftp.readdir("outbound-bank", (e, l) => (e ? reject(e) : resolve(l)));
      });
      assert.deepEqual(listed.map((e) => e.filename).sort(), ["payment.xml"]);
      await assert.rejects(
        new Promise((_, reject) => sftp.stat(`outbound-bank/${tempName}`, (e) => (e ? reject(e) : reject(new Error("stat succeeded"))))),
        "stat of an in-flight temp must fail",
      );
      await assert.rejects(
        new Promise((_, reject) => sftp.open(`outbound-bank/${tempName}`, "r", (e) => (e ? reject(e) : reject(new Error("open succeeded"))))),
        "open of an in-flight temp must fail",
      );
      const final = await new Promise<Buffer>((resolve, reject) => {
        sftp.readFile("outbound-bank/payment.xml", (e, d) => (e ? reject(e) : resolve(d)));
      });
      assert.deepEqual(final, Buffer.from("<complete/>"));
    } finally {
      client.end();
    }
  } finally {
    await server.close();
  }
});

test.after(() => {
  rmSync(scratchDataDir, { recursive: true, force: true });
});
