import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { once } from "node:events";
import ssh2 from "ssh2";
import type { SessionLiveness, SftpResolver, SftpServerConfig } from "./server.ts";

// The local SFTP backend reads its data root from the engine env snapshot.
// Set a throwaway root before loading the server module, just like the other
// SFTP integration suites do.
const scratchDataDir = mkdtempSync(join(tmpdir(), "openbooks-sftp-server-"));
const { env } = await import("../platform/db.ts");
env.OPENBOOKS_DATA_DIR = scratchDataDir;

const { DEFAULT_SFTP_LIMITS, generateHostKey, sftpSessionLimits, startSftpServer } = await import("./server.ts");

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

function connectPassword(username: string, password: string): Promise<ssh2.Client> {
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
    client.connect({ host: "127.0.0.1", port: serverPort, username, password, hostVerifier: () => true });
  });
}

/** A resolver whose liveness the test flips, standing in for the DB fence. */
function livelyResolver() {
  let live: SessionLiveness = { alive: true };
  const resolver: SftpResolver = {
    async password(username: string, _password: string): Promise<SftpServerConfig | null> {
      return username === config.username ? { ...config } : null;
    },
    async checkSession(_config: SftpServerConfig): Promise<SessionLiveness> {
      return live;
    },
  };
  return {
    resolver,
    kill: (reason: string) => { live = { alive: false, reason }; },
  };
}

let serverPort = 0;

async function withServer<T>(
  fn: () => Promise<T>,
  resolver: SftpResolver = resolve(),
  limits?: { maxFileBytes?: number; maxOpenHandles?: number; maxSessionBufferBytes?: number },
): Promise<T> {
  const server = await startSftpServer({ port: 0, hostKey: generateHostKey(), resolve: resolver, limits });
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

function readChunk(sftp: ssh2.SFTPWrapper, handle: Buffer, offset: number, length: number): Promise<Buffer> {
  return new Promise((resolveRead, reject) => {
    sftp.read(handle, Buffer.alloc(length), 0, length, offset, (error, _bytes, data) => error ? reject(error) : resolveRead(data));
  });
}

function opendir(sftp: ssh2.SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolveDir, reject) => {
    sftp.opendir(path, (error, handle) => error ? reject(error) : resolveDir(handle));
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

function mkdir(sftp: ssh2.SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolveMkdir, reject) => {
    sftp.mkdir(path, (error) => error ? reject(error) : resolveMkdir());
  });
}

function rmdir(sftp: ssh2.SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolveRmdir, reject) => {
    sftp.rmdir(path, (error) => error ? reject(error) : resolveRmdir());
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

test("a sparse high-offset write refuses with a named reason instead of gap-filling", async () => {
  await withServer(async () => {
    const client = await connect(privateKey());
    try {
      const sftp = await sftpSession(client);
      const handle = await open(sftp, "sparse.bin", "w");
      try {
        // RED before the fix: Buffer.alloc(end) gap-filled ~10 MiB for one
        // byte (and ~4 GiB at a 0xFFFFFFFF offset) inside the shared process.
        await assert.rejects(
          write(sftp, handle, Buffer.from("x"), 10 * 1024 * 1024),
          /per-file SFTP limit/,
        );
        // The refused write allocated nothing and the handle still works.
        await write(sftp, handle, Buffer.from("ok"), 512);
      } finally {
        await close(sftp, handle);
      }
      assert.deepEqual((await readFile(sftp, "sparse.bin")).subarray(512, 514), Buffer.from("ok"));
    } finally {
      client.end();
    }
  }, resolve(), { maxFileBytes: 1024 });
});

test("an over-cap file refuses to OPEN for read and for resume, before any read", async () => {
  const dir = join(scratchDataDir, "sftp", config.rootPrefix);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "big.bin"), Buffer.alloc(2048, 7));
  writeFileSync(join(dir, "small.bin"), Buffer.from("fits"));
  await withServer(async () => {
    const client = await connect(privateKey());
    try {
      const sftp = await sftpSession(client);
      // RED before the fix: the whole 2048-byte object was read into the
      // session before anything checked its size.
      await assert.rejects(open(sftp, "big.bin", "r"), /per-file SFTP limit/);
      await assert.rejects(open(sftp, "big.bin", "r+"), /per-file SFTP limit/);
      const handle = await open(sftp, "small.bin", "r");
      try {
        assert.deepEqual(await readFile(sftp, "small.bin"), Buffer.from("fits"));
      } finally {
        await close(sftp, handle);
      }
    } finally {
      client.end();
    }
  }, resolve(), { maxFileBytes: 1024 });
});

test("concurrent handles and stacked buffers refuse past the session caps", async () => {
  await withServer(async () => {
    const client = await connect(privateKey());
    try {
      const sftp = await sftpSession(client);
      const first = await open(sftp, "stack-a.bin", "w");
      await write(sftp, first, Buffer.alloc(1500, 1), 0);
      const second = await open(sftp, "stack-b.bin", "w");
      try {
        // RED before the fix: every connection buffered without bound until CLOSE.
        await assert.rejects(write(sftp, second, Buffer.alloc(1500, 2), 0), /per-session SFTP buffer limit/);
      } finally {
        await close(sftp, second);
      }
      await close(sftp, first);
    } finally {
      client.end();
    }
  }, resolve(), { maxFileBytes: 2048, maxSessionBufferBytes: 2048 });

  await withServer(async () => {
    const client = await connect(privateKey());
    try {
      const sftp = await sftpSession(client);
      const first = await open(sftp, "handle-a.bin", "w");
      const second = await open(sftp, "handle-b.bin", "w");
      try {
        await assert.rejects(open(sftp, "handle-c.bin", "w"), /too many open files/);
        await close(sftp, first);
        const third = await open(sftp, "handle-c.bin", "w");
        await close(sftp, third);
      } finally {
        await close(sftp, second);
      }
    } finally {
      client.end();
    }
  }, resolve(), { maxOpenHandles: 2 });
});

test("session limit env overrides apply, and garbage never disables a cap", () => {
  const saved = {
    file: process.env.SFTP_MAX_FILE_BYTES,
    handles: process.env.SFTP_MAX_OPEN_HANDLES,
    session: process.env.SFTP_MAX_SESSION_BUFFER_BYTES,
  };
  try {
    delete process.env.SFTP_MAX_FILE_BYTES;
    delete process.env.SFTP_MAX_OPEN_HANDLES;
    delete process.env.SFTP_MAX_SESSION_BUFFER_BYTES;
    assert.deepEqual(sftpSessionLimits(), DEFAULT_SFTP_LIMITS);

    process.env.SFTP_MAX_FILE_BYTES = "4096";
    process.env.SFTP_MAX_OPEN_HANDLES = "8";
    assert.deepEqual(sftpSessionLimits(), {
      maxFileBytes: 4096,
      maxOpenHandles: 8,
      maxSessionBufferBytes: DEFAULT_SFTP_LIMITS.maxSessionBufferBytes,
    });

    process.env.SFTP_MAX_FILE_BYTES = "banana";
    process.env.SFTP_MAX_OPEN_HANDLES = "-3";
    process.env.SFTP_MAX_SESSION_BUFFER_BYTES = "0";
    assert.deepEqual(sftpSessionLimits(), DEFAULT_SFTP_LIMITS);
  } finally {
    if (saved.file === undefined) delete process.env.SFTP_MAX_FILE_BYTES;
    else process.env.SFTP_MAX_FILE_BYTES = saved.file;
    if (saved.handles === undefined) delete process.env.SFTP_MAX_OPEN_HANDLES;
    else process.env.SFTP_MAX_OPEN_HANDLES = saved.handles;
    if (saved.session === undefined) delete process.env.SFTP_MAX_SESSION_BUFFER_BYTES;
    else process.env.SFTP_MAX_SESSION_BUFFER_BYTES = saved.session;
  }
});

test("a held connection can no longer read or write once the login is disabled", async () => {
  const lively = livelyResolver();
  await withServer(async () => {
    const clients: ssh2.Client[] = [];
    const freshSftp = async (): Promise<ssh2.SFTPWrapper> => {
      // A refused operation ends the connection, so every post-revocation
      // probe reconnects: each operation class below is fenced on its own.
      const client = await connectPassword(config.username, "test-password");
      clients.push(client);
      return sftpSession(client);
    };
    try {
      // While alive, reads and writes work. The reader and the resume-writer
      // below stay open across the revocation: the fence must stop their
      // next operation too, not just fresh OPENs.
      const setup = await freshSftp();
      const writer = await open(setup, "held.txt", "w");
      await write(setup, writer, Buffer.from("before"), 0);
      await close(setup, writer);
      const reader = await open(setup, "held.txt", "r");
      assert.deepEqual(await readChunk(setup, reader, 0, 6), Buffer.from("before"));
      const resumer = await open(setup, "held.txt", "r+");

      lively.kill("sftp login 'sftp-test' is disabled — ask your administrator to re-enable it, then reconnect");

      // RED before the fix: the config was cached for the whole connection,
      // so every one of these succeeded after the disable.
      await assert.rejects(open(await freshSftp(), "held.txt", "r"), /is disabled/);
      await assert.rejects(write(await freshSftp(), resumer, Buffer.from("after"), 0), /is disabled/);
      await assert.rejects(readChunk(await freshSftp(), reader, 0, 6), /is disabled/);
      await assert.rejects(opendir(await freshSftp(), "/"), /is disabled/);
    } finally {
      for (const client of clients) client.end();
    }
  }, lively.resolver);
});

test("a held connection can no longer read or write after credential rotation", async () => {
  const lively = livelyResolver();
  await withServer(async () => {
    const clients: ssh2.Client[] = [];
    const freshSftp = async (): Promise<ssh2.SFTPWrapper> => {
      const client = await connectPassword(config.username, "test-password");
      clients.push(client);
      return sftpSession(client);
    };
    try {
      const setup = await freshSftp();
      const writer = await open(setup, "rotated.txt", "w");
      await write(setup, writer, Buffer.from("before"), 0);

      lively.kill("sftp login 'sftp-test' credentials changed — reconnect with the current password or key");

      await assert.rejects(write(await freshSftp(), writer, Buffer.from("after"), 0), /credentials changed/);
      await assert.rejects(open(await freshSftp(), "rotated.txt", "r"), /credentials changed/);
    } finally {
      for (const client of clients) client.end();
    }
  }, lively.resolver);
});

test("revoke ends only the revoked server's live sessions", async () => {
  const serverA: SftpServerConfig = { ...config, id: "server-a", username: "login-a" };
  const serverB: SftpServerConfig = { ...config, id: "server-b", username: "login-b" };
  const both: SftpResolver = {
    async password(username: string, _password: string) {
      if (username === "login-a") return serverA;
      if (username === "login-b") return serverB;
      return null;
    },
  };
  const handle = await startSftpServer({ port: 0, hostKey: generateHostKey(), resolve: both });
  serverPort = handle.port;
  const clientA = await connectPassword("login-a", "pw");
  const clientB = await connectPassword("login-b", "pw");
  try {
    const sftpA = await sftpSession(clientA);
    const sftpB = await sftpSession(clientB);
    const dirA = await opendir(sftpA, "/");
    await close(sftpA, dirA);

    handle.revoke("server-a");
    // The revoked login's connection ends promptly. (No SFTP operation is
    // issued on it afterwards: ssh2 never settles a request sent on an
    // already-dead channel, so the disconnect itself is the assertion.)
    await once(clientA, "close");

    // ...while the other login on the same listener is untouched.
    const dirB = await opendir(sftpB, "/");
    await close(sftpB, dirB);

    // Unknown ids are a no-op, never a throw.
    handle.revoke("no-such-server");
  } finally {
    clientA.end();
    clientB.end();
    await handle.close();
  }
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

test("RMDIR of a populated folder fails with the refusal instead of a phantom success", async () => {
  await withServer(async () => {
    const client = await connect(privateKey());
    try {
      const sftp = await sftpSession(client);
      await mkdir(sftp, "populated");
      const handle = await open(sftp, "populated/statement.ofx", "w");
      await write(sftp, handle, Buffer.from("statement"), 0);
      await close(sftp, handle);

      // RED before the fix (S3): the daemon answered RMDIR OK after deleting
      // only the folder marker, while the statements still imported. Now the
      // refusal arrives with the SFTP failure status and names the folder.
      const failure = await rmdir(sftp, "populated").then(
        () => null,
        (error: Error & { code?: number }) => error,
      );
      assert.ok(failure, "removing a populated folder must fail");
      assert.equal(failure.code, 4, "the refusal carries the SFTP FAILURE status, not NO_SUCH_FILE");
      assert.match(failure.message, /populated.*not empty/);

      // The folder and its statement survive the refusal; an emptied folder
      // still removes cleanly.
      assert.deepEqual(await readFile(sftp, "populated/statement.ofx"), Buffer.from("statement"));
      await mkdir(sftp, "void");
      await rmdir(sftp, "void");
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
