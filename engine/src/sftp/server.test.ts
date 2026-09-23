import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ssh2 from "ssh2";

// The local SFTP backend reads its data root from the engine env snapshot.
// Set a throwaway root before loading the server module, just like the other
// SFTP integration suites do.
const scratchDataDir = mkdtempSync(join(tmpdir(), "openbooks-sftp-server-"));
const { env } = await import("../platform/db.ts");
env.OPENBOOKS_DATA_DIR = scratchDataDir;

const { generateHostKey, startSftpServer } = await import("./server.ts");

const keyPair = { private: generateHostKey() };
const parsedPublic = (() => {
  const parsed = ssh2.utils.parseKey(keyPair.private);
  if (parsed instanceof Error) throw parsed;
  return parsed;
})();

function privateKey(): ssh2.ParsedKey {
  const parsed = ssh2.utils.parseKey(keyPair.private);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

const config = {
  id: "server-test",
  orgId: "server-test-org",
  username: "sftp-test",
  backend: "local",
  bucket: null,
  rootPrefix: "sftp/server-test-org/fixtures",
};

function resolve() {
  return {
    async password() { return null; },
    async publicKey(_username: string, keyAlgo: string, keyData: Buffer) {
      return keyAlgo === parsedPublic.type && keyData.equals(parsedPublic.getPublicSSH()) ? config : null;
    },
  };
}

function connect(key: ssh2.ParsedKey): Promise<ssh2.Client> {
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
    client.connect({
      host: "127.0.0.1",
      port: serverPort,
      username: config.username,
      hostVerifier: () => true,
      authHandler: [{ type: "publickey", username: config.username, key } as ssh2.PublicKeyAuthMethod],
    });
  });
}

let serverPort = 0;

async function withServer<T>(fn: () => Promise<T>, resolver = resolve()): Promise<T> {
  const server = await startSftpServer({ port: 0, hostKey: generateHostKey(), resolve: resolver });
  serverPort = server.port;
  try {
    return await fn();
  } finally {
    await server.close();
  }
}

function sftpSession(client: ssh2.Client): Promise<ssh2.SFTPWrapper> {
  return new Promise((resolveSftp, reject) => {
    client.sftp((error, sftp) => error ? reject(error) : resolveSftp(sftp));
  });
}

function open(sftp: ssh2.SFTPWrapper, path: string, mode: ssh2.OpenMode): Promise<Buffer> {
  return new Promise((resolveHandle, reject) => {
    sftp.open(path, mode, (error, handle) => error ? reject(error) : resolveHandle(handle));
  });
}

function write(sftp: ssh2.SFTPWrapper, handle: Buffer, data: Buffer, position: number): Promise<void> {
  return new Promise((resolveWrite, reject) => {
    sftp.write(handle, data, 0, data.length, position, (error) => error ? reject(error) : resolveWrite());
  });
}

function close(sftp: ssh2.SFTPWrapper, handle: Buffer): Promise<void> {
  return new Promise((resolveClose, reject) => {
    sftp.close(handle, (error) => error ? reject(error) : resolveClose());
  });
}

function readFile(sftp: ssh2.SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolveFile, reject) => {
    sftp.readFile(path, (error, data) => error ? reject(error) : resolveFile(data));
  });
}

function setstat(sftp: ssh2.SFTPWrapper, path: string, attrs: ssh2.InputAttributes): Promise<void> {
  return new Promise((resolveSet, reject) => {
    sftp.setstat(path, attrs, (error) => error ? reject(error) : resolveSet());
  });
}

function fsetstat(sftp: ssh2.SFTPWrapper, handle: Buffer, attrs: ssh2.InputAttributes): Promise<void> {
  return new Promise((resolveSet, reject) => {
    sftp.fsetstat(handle, attrs, (error) => error ? reject(error) : resolveSet());
  });
}

test("public-key authentication rejects an invalid signature but accepts a valid one", async () => {
  const untrusted = ssh2.utils.parseKey(keyPair.private);
  if (untrusted instanceof Error) throw untrusted;
  untrusted.sign = () => Buffer.alloc(64);

  await withServer(async () => {
    // RED before the fix: ssh2 would reach ready because the resolver result
    // was accepted without checking this fabricated signature.
    await assert.rejects(connect(untrusted), /All configured authentication methods failed|authentication/i);

    const client = await connect(privateKey());
    client.end();
  });
});

test("SFTP writes honor offsets and preserve bytes when opening without truncation", async () => {
  await withServer(async () => {
    const client = await connect(privateKey());
    try {
      const sftp = await sftpSession(client);

      const created = await open(sftp, "offsets.bin", "w");
      await write(sftp, created, Buffer.from("DEF"), 3);
      await write(sftp, created, Buffer.from("ABC"), 0);
      await close(sftp, created);
      assert.deepEqual(await readFile(sftp, "offsets.bin"), Buffer.from("ABCDEF"));

      const existing = await open(sftp, "offsets.bin", "r+");
      await write(sftp, existing, Buffer.from("Z"), 2);
      await close(sftp, existing);
      // RED before the fix: opening r+ started an empty buffer and CLOSE
      // silently replaced the existing object with only the new chunk.
      assert.deepEqual(await readFile(sftp, "offsets.bin"), Buffer.from("ABZDEF"));
    } finally {
      client.end();
    }
  });
});

test("an authorized_keys line that passed validation authenticates a real signed login end to end", async () => {
  const { validateAuthorizedKeys } = await import("./authorized-keys.ts");
  const pair = ssh2.utils.generateKeyPairSync("ed25519");
  if (typeof pair.public !== "string") throw new Error("expected an OpenSSH public key line");
  // Stored exactly as the creation route stores it: validated, normalized.
  const stored = validateAuthorizedKeys(`  ${pair.public.trim()}   bank@example.com  \n`).join("\n");
  const loginKey = ssh2.utils.parseKey(pair.private);
  if (loginKey instanceof Error) throw loginKey;
  // The production matcher shape from manager.ts, reading the stored text.
  const textResolver = {
    async password() { return null; },
    async publicKey(_username: string, keyAlgo: string, keyData: Buffer) {
      for (const line of stored.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const parsed = ssh2.utils.parseKey(trimmed);
        if (parsed instanceof Error) continue;
        if (parsed.type === keyAlgo && parsed.getPublicSSH().equals(keyData)) return config;
      }
      return null;
    },
  };
  await withServer(async () => {
    const client = await connect(loginKey);
    try {
      const sftp = await sftpSession(client);
      const handle = await open(sftp, "validated-login.bin", "w");
      await write(sftp, handle, Buffer.from("key login works"), 0);
      await close(sftp, handle);
      assert.deepEqual(await readFile(sftp, "validated-login.bin"), Buffer.from("key login works"));
    } finally {
      client.end();
    }
  }, textResolver);
});

test("SETSTAT and FSETSTAT refuse instead of answering OK for a no-op", async () => {
  await withServer(async () => {
    const client = await connect(privateKey());
    try {
      const sftp = await sftpSession(client);

      const created = await open(sftp, "truncate-me.bin", "w");
      await write(sftp, created, Buffer.from("original bytes"), 0);
      await close(sftp, created);

      // RED before the fix: both answered STATUS_CODE.OK while changing
      // nothing, so a partner's SETSTAT(size=0) looked like a cleared
      // upload while the original bytes still posted.
      await assert.rejects(setstat(sftp, "truncate-me.bin", { size: 0 }), /not supported/i);

      const handle = await open(sftp, "truncate-me.bin", "r+");
      try {
        await assert.rejects(fsetstat(sftp, handle, { size: 0 }), /not supported/i);
      } finally {
        await close(sftp, handle);
      }

      // The refused truncate changed nothing: the original bytes survive.
      assert.deepEqual(await readFile(sftp, "truncate-me.bin"), Buffer.from("original bytes"));
    } finally {
      client.end();
    }
  });
});

test.after(() => {
  rmSync(scratchDataDir, { recursive: true, force: true });
});


test("host-key generation refuses malformed dependency output before persistence", (t) => {
  const valid = generateHostKey();
  let attempts = 0;
  t.mock.method(ssh2.utils, "generateKeyPairSync", () => ({
    private: ++attempts === 1 ? "malformed generated key" : valid,
    public: "unused",
  }));
  const recovered = generateHostKey();
  assert.equal(attempts, 2);
  assert.equal(recovered, valid);
  assert.ok(!(ssh2.utils.parseKey(recovered) instanceof Error));
});

test("host-key generation has a bounded failure and never returns an invalid identity", (t) => {
  let attempts = 0;
  t.mock.method(ssh2.utils, "generateKeyPairSync", () => {
    attempts++;
    return { private: "malformed generated key", public: "unused" };
  });
  assert.throws(() => generateHostKey(), /Could not generate a valid SFTP host key/);
  assert.equal(attempts, 8);
});
