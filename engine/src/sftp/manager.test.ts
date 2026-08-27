import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import {
  ensureSftpServer,
  sftpListenerState,
  stopSftpServer,
  type DaemonConfig,
} from "./manager.ts";
import { generateHostKey } from "./server.ts";

/**
 * Listener lifecycle for the shared SFTP daemon — DB-free: the reconcile
 * entry point takes an injectable config source (production always reads the
 * singleton DB row), so these tests exercise the real bind/cutover behavior
 * without a database.
 */

const hostKey = generateHostKey();

function listen(server: net.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // The SFTP listener binds the IPv4 wildcard, so the conflicting occupier
    // must hold the exact same (addr, port): a specific-address bind would
    // coexist with a wildcard bind under BSD SO_REUSEADDR semantics.
    server.listen(port, "0.0.0.0", () => resolve());
  });
}

function freePort(): Promise<number> {
  const server = net.createServer();
  return listen(server, 0).then(() => {
    const port = (server.address() as net.AddressInfo).port;
    return new Promise<number>((resolve) => server.close(() => resolve(port)));
  });
}

/** Resolve when the port accepts a TCP connection; reject when it refuses. */
function probe(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });
}

function config(port: number): DaemonConfig {
  return { enabled: true, port, hostKey, advertisedHost: null };
}

test("a failed bind keeps the previous listener serving and propagates instead of reporting success", async () => {
  const port = await freePort();
  await ensureSftpServer(() => Promise.resolve(config(port)));
  try {
    const blocked = await freePort();
    const occupier = net.createServer();
    await listen(occupier, blocked);
    try {
      // RED on the pre-fix manager: it stopped the working listener first,
      // swallowed this bind failure, and returned as if nothing happened.
      await assert.rejects(
        ensureSftpServer(() => Promise.resolve(config(blocked))),
        /EADDRINUSE/,
      );

      // The previously working daemon is untouched and still answers.
      assert.deepEqual(sftpListenerState(), { listening: true, port });
      await probe(port);

      // Control: a valid cutover still succeeds and the old port goes dark.
      const next = await freePort();
      await ensureSftpServer(() => Promise.resolve(config(next)));
      assert.deepEqual(sftpListenerState(), { listening: true, port: next });
      await probe(next);
      await assert.rejects(probe(port));
    } finally {
      await new Promise<void>((resolve) => occupier.close(() => resolve()));
    }
  } finally {
    await stopSftpServer();
  }
});

test("a successful cutover binds the new port before the old listener closes", async () => {
  const first = await freePort();
  await ensureSftpServer(() => Promise.resolve(config(first)));
  try {
    const second = await freePort();
    await ensureSftpServer(() => Promise.resolve(config(second)));
    assert.deepEqual(sftpListenerState(), { listening: true, port: second });
    await probe(second);
    await assert.rejects(probe(first));
  } finally {
    await stopSftpServer();
  }

  // Disabling stops the daemon and unbinds the port.
  await ensureSftpServer(() =>
    Promise.resolve({ enabled: false, port: 2222, hostKey, advertisedHost: null }));
  assert.deepEqual(sftpListenerState(), { listening: false, port: null });
});
