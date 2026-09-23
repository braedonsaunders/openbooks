import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import {
  ensureSftpServer,
  hostKeyFingerprint,
  loadDaemonConfig,
  sftpListenerState,
  stopSftpServer,
  type DaemonConfig,
} from "./manager.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateHostKey } from "./server.ts";

// Enabling the daemon requires configured storage (see backend.ts): hand the
// engine env snapshot a throwaway absolute data root before exercising the
// listener lifecycle, so these stay pure bind/cutover tests.
const scratchDataDir = mkdtempSync(join(tmpdir(), "openbooks-sftp-manager-"));
const { env } = await import("../platform/db.ts");
env.OPENBOOKS_DATA_DIR = scratchDataDir;

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

/**
 * Flatten a drizzle SQL chunk enough to classify select vs insert. Same
 * approach as the other engine unit doubles that inspect `queryChunks`.
 */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      const value = (chunk as { value?: unknown[] })?.value;
      if (Array.isArray(value)) return value.map(String).join("");
      return (chunk as { queryChunks?: unknown[] })?.queryChunks ? sqlText(chunk) : "";
    })
    .join("");
}

function asRunner(execute: (query: unknown) => Promise<{ rows: unknown[] }>): SqlExecutor {
  return { execute: execute as SqlExecutor["execute"] };
}

const storedWinner = {
  enabled: false,
  port: 2222,
  host_key: generateHostKey(),
  advertised_host: null as string | null,
};

/**
 * Concurrent first-load: both SELECTs miss, this insert loses
 * (`on conflict do nothing` matches zero rows), and the winner's PEM is
 * what a later read observes. Mirrors the username-mint race in
 * `web/app/api/banking/sftp/route.ts` — claim atomically, then observe
 * the stored row; never trust the discarded in-memory secret.
 */
function lostInsertRaceRunner(opts: { persistWinner: boolean }) {
  let visible = false;
  return asRunner(async (query) => {
    const text = sqlText(query);
    if (/insert into sftp_daemon/i.test(text)) {
      visible = opts.persistWinner;
      return { rows: [] };
    }
    if (/from sftp_daemon/i.test(text)) {
      return { rows: visible ? [storedWinner] : [] };
    }
    throw new Error(`unexpected daemon query: ${text}`);
  });
}

test("a first-load that loses the insert advertises the persisted host key, not the discarded in-memory one", async () => {
  // RED on the pre-fix manager: after a SELECT miss it generated a key,
  // inserted with `on conflict do nothing`, and returned that in-memory
  // PEM without re-reading. The tenant connection-details surface fingerprints
  // whatever loadDaemonConfig returns, so the operator could pin a host key
  // sftp_daemon never stored.
  const cfg = await loadDaemonConfig(lostInsertRaceRunner({ persistWinner: true }));
  assert.equal(cfg.hostKey, storedWinner.host_key);
  assert.equal(hostKeyFingerprint(cfg.hostKey), hostKeyFingerprint(storedWinner.host_key));
  assert.deepEqual(cfg, {
    enabled: storedWinner.enabled,
    port: storedWinner.port,
    hostKey: storedWinner.host_key,
    advertisedHost: storedWinner.advertised_host,
  });
});

test("a first-load that cannot observe a persisted row after a lost insert fails closed", async () => {
  await assert.rejects(
    () => loadDaemonConfig(lostInsertRaceRunner({ persistWinner: false })),
    /sftp_daemon row 'default' is missing after provision.*retry the load/i,
  );
});

test.after(() => {
  rmSync(scratchDataDir, { recursive: true, force: true });
});

test("enabling the daemon without shared storage configured refuses by name before binding", async () => {
  // Listener-start gate: local storage with no absolute shared root must name
  // the misconfiguration instead of serving logins whose uploads the
  // importer never sees.
  // Pin the whole storage selection surface: ambient S3 variables would
  // otherwise select object storage and this would bind instead of refusing.
  const storageVars = ["S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET", "OPENBOOKS_DATA_DIR"];
  const saved = new Map(storageVars.map((name) => [name, { process: process.env[name], snapshot: (env as Record<string, string | undefined>)[name] }]));
  for (const name of storageVars) {
    delete process.env[name];
    delete (env as Record<string, string | undefined>)[name];
  }
  try {
    await assert.rejects(
      ensureSftpServer(() => Promise.resolve(config(2222))),
      /Local SFTP storage needs OPENBOOKS_DATA_DIR/,
    );
    assert.deepEqual(sftpListenerState(), { listening: false, port: null });
  } finally {
    for (const name of storageVars) {
      const { process: processValue, snapshot: snapshotValue } = saved.get(name)!;
      if (processValue !== undefined) process.env[name] = processValue;
      if (snapshotValue !== undefined) (env as Record<string, string>)[name] = snapshotValue;
    }
  }
});
