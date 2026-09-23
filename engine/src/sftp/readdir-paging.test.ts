import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import ssh2 from "ssh2";

// The local SFTP backend reads its data root from the engine env snapshot.
const scratchDataDir = mkdtempSync(join(tmpdir(), "openbooks-sftp-readdir-"));
const { env } = await import("../platform/db.ts");
env.OPENBOOKS_DATA_DIR = scratchDataDir;

const { backendFor } = await import("./backend.ts");
const { generateHostKey, startSftpServer } = await import("./server.ts");
import type { SftpServerConfig } from "./server.ts";

const ORG = "f3b00000-0000-0000-0000-000000000000";

function passwordResolver(config: SftpServerConfig) {
  return {
    async password(username: string, password: string) {
      return username === config.username && password === "pw" ? config : null;
    },
    async loginSucceeded() {},
  };
}

function connect(port: number, username: string): Promise<ssh2.Client> {
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
    client.connect({ host: "127.0.0.1", port, username, password: "pw", hostVerifier: () => true });
  });
}

function sftpSession(client: ssh2.Client): Promise<ssh2.SFTPWrapper> {
  return new Promise((resolveSftp, reject) => {
    client.sftp((error, sftp) => (error ? reject(error) : resolveSftp(sftp)));
  });
}

function readdir(sftp: ssh2.SFTPWrapper, path: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (error, list) => (error ? reject(error) : resolve(list.map((entry) => entry.filename))));
  });
}

test("a real client lists a directory of more than 1,000 long names completely", async () => {
  const lane = randomUUID().slice(0, 8);
  const rootPrefix = `sftp/${ORG}/readdir-${lane}`;
  const config: SftpServerConfig = {
    id: `readdir-${lane}`, orgId: ORG, username: `readdir-${lane}`, backend: "local",
    bucket: null, rootPrefix,
  };
  const backend = backendFor(config);
  // Long names: one batched reply must stay far under ssh2's 256 KiB packet
  // cap, so 1,200 of these need many READDIR rounds to come back whole.
  const expected: string[] = [];
  for (let i = 0; i < 1200; i++) {
    const name = `bank-statement-${lane}-${String(i).padStart(4, "0")}-with-a-quite-long-descriptive-file-name-for-packet-sizing.csv`;
    expected.push(name);
    await backend.write(`inbound/${name}`, Buffer.from("statement"));
  }

  const server = await startSftpServer({ port: 0, hostKey: generateHostKey(), resolve: passwordResolver(config) });
  const client = await connect(server.port, config.username);
  try {
    const sftp = await sftpSession(client);
    // RED before the fix: the daemon answered READDIR with one NAME packet
    // holding all 1,200 names (~400 KiB), past ssh2's 256 KiB inbound cap —
    // a fatal protocol error after which the client never completes the
    // listing (observed: no result in 200s), even though the backend
    // listing was complete.
    const listed = await readdir(sftp, "inbound");
    assert.equal(listed.length, 1200, "every name must arrive across the bounded READDIR batches");
    assert.deepEqual(new Set(listed), new Set(expected));
  } finally {
    client.end();
    await server.close();
  }
});

test("an empty directory still terminates the listing", async () => {
  const lane = randomUUID().slice(0, 8);
  const rootPrefix = `sftp/${ORG}/readdir-empty-${lane}`;
  const config: SftpServerConfig = {
    id: `readdir-empty-${lane}`, orgId: ORG, username: `readdir-empty-${lane}`, backend: "local",
    bucket: null, rootPrefix,
  };
  const server = await startSftpServer({ port: 0, hostKey: generateHostKey(), resolve: passwordResolver(config) });
  const client = await connect(server.port, config.username);
  try {
    const sftp = await sftpSession(client);
    assert.deepEqual(await readdir(sftp, "missing-dir"), []);
  } finally {
    client.end();
    await server.close();
  }
});

test.after(() => {
  rmSync(scratchDataDir, { recursive: true, force: true });
});
