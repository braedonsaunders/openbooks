import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import ssh2 from "ssh2";

// The local SFTP backend reads its data root from the engine env snapshot.
const scratchDataDir = mkdtempSync(join(tmpdir(), "openbooks-sftp-protect-"));
const { env } = await import("../platform/db.ts");
env.OPENBOOKS_DATA_DIR = scratchDataDir;

const {
  backendFor,
  isProtectedSftpPath,
  setSftpS3ClientForTests,
} = await import("./backend.ts");
const { createFakeS3 } = await import("./fake-s3.ts");
const { generateHostKey, startSftpServer } = await import("./server.ts");
import type { SftpServerConfig } from "./server.ts";

const PERMISSION_DENIED = ssh2.utils.sftp.STATUS_CODE.PERMISSION_DENIED;
const ORG = "f2000000-0000-0000-0000-000000000000";
const PUBLISHED = Buffer.from("approved bank bytes v1");
const PUBLISHED_HASH = createHash("sha256").update(PUBLISHED).digest("hex");

/**
 * An S3 row needs a complete object-store configuration to resolve through
 * backendFor (partial S3 refuses by name). Pin all four variables for the S3
 * suite and restore them after, so this stays hermetic regardless of the
 * ambient environment.
 */
const S3_VARS = ["S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET"] as const;
function pinS3Env(): Map<string, string | undefined> {
  const saved = new Map<string, string | undefined>(
    S3_VARS.map((name) => [name, process.env[name] ?? (env as Record<string, string | undefined>)[name]]),
  );
  for (const name of S3_VARS) process.env[name] = `test-${name.toLowerCase().replace(/_/g, "-")}`;
  return saved;
}
function restoreEnv(saved: Map<string, string | undefined>): void {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function passwordResolver(config: SftpServerConfig) {
  return {
    async password(username: string, password: string) {
      return username === config.username && password === "bank-pw" ? config : null;
    },
    async loginSucceeded() {},
  };
}

function connectPassword(port: number, username: string, password: string): Promise<ssh2.Client> {
  return new Promise((resolveClient, reject) => {
    const client = new ssh2.Client();
    let settled = false;
    client.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    client.once("ready", () => {
      settled = true;
      resolveClient(client);
    });
    client.connect({ host: "127.0.0.1", port, username, password, hostVerifier: () => true });
  });
}

function sftpSession(client: ssh2.Client): Promise<ssh2.SFTPWrapper> {
  return new Promise((resolveSftp, reject) => {
    client.sftp((error, sftp) => (error ? reject(error) : resolveSftp(sftp)));
  });
}

function asStatus(error: unknown): number | undefined {
  return (error as { code?: number })?.code;
}

async function expectDenied(promise: Promise<unknown>, what: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(error, `${what} must be refused`);
  assert.equal(asStatus(error), PERMISSION_DENIED, `${what} must refuse with PERMISSION_DENIED, not another status`);
}

function unlink(sftp: ssh2.SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(path, (error) => (error ? reject(error) : resolve()));
  });
}

function rename(sftp: ssh2.SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (error) => (error ? reject(error) : resolve()));
  });
}

function setstat(sftp: ssh2.SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.setstat(path, { mode: 0o600 }, (error) => (error ? reject(error) : resolve()));
  });
}

function open(sftp: ssh2.SFTPWrapper, path: string, mode: ssh2.OpenMode): Promise<Buffer> {
  return new Promise((resolveHandle, reject) => {
    sftp.open(path, mode, (error, handle) => (error ? reject(error) : resolveHandle(handle)));
  });
}

function close(sftp: ssh2.SFTPWrapper, handle: Buffer): Promise<void> {
  return new Promise((resolveClose, reject) => {
    sftp.close(handle, (error) => (error ? reject(error) : resolveClose()));
  });
}

function readFile(sftp: ssh2.SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolveFile, reject) => {
    sftp.readFile(path, (error, data) => (error ? reject(error) : resolveFile(data)));
  });
}

function writeFile(sftp: ssh2.SFTPWrapper, path: string, data: Buffer): Promise<void> {
  return new Promise((resolveWrite, reject) => {
    sftp.writeFile(path, data, (error) => (error ? reject(error) : resolveWrite()));
  });
}

test("isProtectedSftpPath matches the folder and its spellings, never the root", () => {
  assert.equal(isProtectedSftpPath(["outbound"], "outbound/report.csv"), true);
  assert.equal(isProtectedSftpPath(["outbound"], "outbound"), true);
  assert.equal(isProtectedSftpPath(["outbound"], "outbound/../outbound/report.csv"), true);
  assert.equal(isProtectedSftpPath(["outbound"], "/outbound/report.csv"), true);
  assert.equal(isProtectedSftpPath(["outbound"], "outbound2/report.csv"), false);
  assert.equal(isProtectedSftpPath(["outbound"], "inbound/report.csv"), false);
  assert.equal(isProtectedSftpPath(["outbound"], "/"), false);
  assert.equal(isProtectedSftpPath(undefined, "outbound/report.csv"), false);
  assert.equal(isProtectedSftpPath([], "outbound/report.csv"), false);
  assert.equal(isProtectedSftpPath(["/"], "anything.csv"), false);
  assert.equal(isProtectedSftpPath(["bank/payments"], "bank/payments/run.csv"), true);
  assert.equal(isProtectedSftpPath(["bank/payments"], "bank/other.csv"), false);
});

/**
 * After the app publishes an approved bank file, the whole protection suite
 * runs against one session backend: every mutation of the published file is
 * refused with PERMISSION_DENIED, the bytes and hash are unchanged, and the
 * inbound folder stays writable. Runs for BOTH local and S3 backends.
 */
async function protectionSuite(kind: "local" | "s3"): Promise<void> {
  const lane = randomUUID().slice(0, 8);
  const rootPrefix = `sftp/${ORG}/protect-${lane}`;
  const savedEnv = kind === "s3" ? pinS3Env() : null;
  // The shared S3 client is process-global: the fake is installed for the
  // S3 suite only and always restored, so the local suite (and every other
  // file, which runs in its own process) keeps the real client.
  const fake = kind === "s3" ? createFakeS3() : null;
  if (fake) setSftpS3ClientForTests(fake.client);
  try {
    const config: SftpServerConfig = kind === "s3"
      ? {
        id: `protect-${lane}`, orgId: ORG, username: `protect-${lane}`, backend: "s3",
        bucket: "protect-bucket", rootPrefix, readOnlyDirs: ["outbound"],
      }
      : {
        id: `protect-${lane}`, orgId: ORG, username: `protect-${lane}`, backend: "local",
        bucket: null, rootPrefix, readOnlyDirs: ["outbound"],
      };
    const sessionBackend = backendFor(config);

    // The app's publish (import-job writes through its own backend, never a
    // session): the bytes the delivery evidence will hash.
    await sessionBackend.write("outbound/report.csv", PUBLISHED);
    await sessionBackend.write("inbound/drop.csv", Buffer.from("statement"));

    const server = await startSftpServer({ port: 0, hostKey: generateHostKey(), resolve: passwordResolver(config) });
    const client = await connectPassword(server.port, config.username, "bank-pw");
    try {
      const sftp = await sftpSession(client);

      // RED before the fix: every one of these succeeded and rewrote or
      // removed the approved artifact while delivery evidence described it.
      await expectDenied(open(sftp, "outbound/report.csv", "w").then((h) => close(sftp, h)), "truncate+write open");
      await expectDenied(open(sftp, "outbound/report.csv", "a").then((h) => close(sftp, h)), "append open");
      await expectDenied(open(sftp, "outbound/report.csv", "r+").then((h) => close(sftp, h)), "read/write open");
      await expectDenied(open(sftp, "outbound/fresh.csv", "w").then((h) => close(sftp, h)), "create inside outbound");
      await expectDenied(unlink(sftp, "outbound/report.csv"), "remove");
      await expectDenied(rename(sftp, "outbound/report.csv", "outbound/renamed.csv"), "rename away");
      await expectDenied(rename(sftp, "inbound/drop.csv", "outbound/planted.csv"), "rename into outbound");
      await expectDenied(rename(sftp, "outbound/report.csv", "inbound/stolen.csv"), "rename out of outbound");
      await expectDenied(setstat(sftp, "outbound/report.csv"), "setstat");

      // Reads, stat, listing, and the inbound folder are unaffected.
      assert.deepEqual(await readFile(sftp, "outbound/report.csv"), PUBLISHED);
      await writeFile(sftp, "inbound/note.txt", Buffer.from("bank statement"));
      assert.deepEqual(await readFile(sftp, "inbound/note.txt"), Buffer.from("bank statement"));
      await rename(sftp, "inbound/drop.csv", "inbound/processed.csv");
      assert.deepEqual(await readFile(sftp, "inbound/processed.csv"), Buffer.from("statement"));
    } finally {
      client.end();
      await server.close();
    }

    // The published bytes and their hash survived every refused mutation.
    const after = await sessionBackend.read("outbound/report.csv");
    assert.deepEqual(after, PUBLISHED);
    assert.equal(createHash("sha256").update(after).digest("hex"), PUBLISHED_HASH);
  } finally {
    if (fake) setSftpS3ClientForTests(null);
    if (savedEnv) restoreEnv(savedEnv);
  }
}

test("published payment files are read-only over SFTP (local backend)", async () => {
  await protectionSuite("local");
});

test("published payment files are read-only over SFTP (S3 backend)", async () => {
  await protectionSuite("s3");
});

test.after(() => {
  setSftpS3ClientForTests(null);
  rmSync(scratchDataDir, { recursive: true, force: true });
});
