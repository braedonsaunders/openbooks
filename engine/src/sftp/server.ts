import ssh2 from "ssh2";
import type { Connection } from "ssh2";
import { backendFor, cleanPath, isProtectedSftpPath, isSftpTempName, SftpDirectoryNotEmptyError, type SftpBackend } from "./backend.ts";

const { Server, utils } = ssh2;
const { STATUS_CODE, OPEN_MODE } = utils.sftp;

/**
 * The built-in SFTP server. One ssh2 daemon hosts any number of *virtual*
 * SFTP servers — each is a login (username + password/keys) whose filesystem is
 * a bucket/prefix (MinIO) or a folder (local). Banks and partners connect with
 * a normal SFTP client to drop statement files or fetch payment files; the same
 * objects are what the import pipeline reads and the payment exporter writes.
 *
 * The daemon is storage-agnostic (see backend.ts) and config-agnostic: a
 * `resolve` callback authenticates a login and returns its server config, so
 * the same daemon serves DB-backed orgs in production and a fixed config in
 * tests.
 */

export interface SftpServerConfig {
  id: string;
  /** Owning tenant — the physical storage root is always validated against it. */
  orgId: string;
  username: string;
  backend: string; // 's3' | 'local'
  bucket: string | null;
  rootPrefix: string;
  /**
   * Backend-relative folders published by the system (payment outbound
   * folders) that this login may read but never mutate. Populated by the
   * resolver from the server's own configured payment folders — never
   * hardcoded — so a bank credential cannot overwrite, truncate, rename,
   * or delete an approved bank file while delivery evidence describes it.
   */
  readOnlyDirs?: string[];
  /**
   * Opaque credential/state version captured at authentication (the DB
   * resolver fills this from the row's updated_at plus its credential
   * material). The per-operation liveness fence hands the whole config back
   * to the resolver, which compares this against the live row: any rotation,
   * disable, or delete since auth fails the fence.
   */
  sessionRev?: string;
}

/**
 * Outcome of the per-operation liveness fence. A dead session names its
 * reason — the daemon surfaces it on the refused operation so the operator
 * sees the remedy, not a bare failure code.
 */
export type SessionLiveness = { alive: true } | { alive: false; reason: string };

export interface SftpResolver {
  /**
   * Return the server config if the password authenticates this login.
   * Side-effect free: matching must not record anything — the daemon calls
   * loginSucceeded only after the session is accepted.
   */
  password(username: string, password: string): Promise<SftpServerConfig | null>;
  /**
   * Return the server config if the public key authenticates this login.
   * Side-effect free, and called for the UNSIGNED probe as well as the
   * signed attempt: matching alone never records a connection.
   */
  publicKey?(username: string, keyAlgo: string, keyData: Buffer): Promise<SftpServerConfig | null>;
  /**
  /**
   * Record a successful login (e.g. last-connected bookkeeping). Called at
   * most once per connection, only after ctx.accept of a VERIFIED attempt —
   * never for an unsigned probe and never for a rejected signature. A throw
   * rejects the login instead of accepting an unrecorded session.
   */
  loginSucceeded?(config: SftpServerConfig): Promise<void>;
  /**
   * Re-validate a live session's config against the current authority
   * (is_active, credential version, owning-org Bank Feeds feature). Absent
   * means every session stays alive — fixed-config tests and resolvers with
   * no revocation source. Production's DB resolver implements it; the daemon
   * calls it before EVERY SFTP operation, so a disable, rotation, or
   * feature-off takes effect on the session's next request no matter which
   * process serves the daemon.
   */
  checkSession?(config: SftpServerConfig): Promise<SessionLiveness>;
}

interface OpenFile { path: string; backend: SftpBackend; write: boolean; append: boolean; buf: Buffer<ArrayBufferLike> }
interface OpenDir { entries: { name: string; isDir: boolean; size: number; mtimeMs: number }[]; next: number }

/**
 * Bounds for one READDIR reply. ssh2 builds a single response packet per
 * NAME reply and its parser rejects packets over 256 KiB (ordinary clients
 * often cap lower), so a directory of enough or long names must be streamed
 * in batches: at most 100 entries and at most ~32 KiB of estimated encoded
 * names per reply, then EOF. At least one entry is always returned per call
 * so iteration always makes progress.
 */
const MAX_READDIR_ENTRIES = 100;
const MAX_READDIR_BYTES = 32 * 1024;

/**
 * Per-session resource caps for one SFTP connection. Every OPEN reads the
 * whole remote object into the session's memory and every open file stays
 * buffered until CLOSE, so without caps one valid credential can force
 * multi-GB allocations in the shared web process (a 1-byte WRITE at a ~4
 * GiB offset gap-fills a 4 GiB buffer; many large OPENs stack). All three
 * are enforced BEFORE allocation or read, and again on the storage write,
 * refusing with FAILURE and a named reason.
 */
export interface SftpSessionLimits {
  /** Refuse any file whose total size would exceed this many bytes. */
  maxFileBytes: number;
  /** Refuse OPEN/OPENDIR once a session holds this many handles. */
  maxOpenHandles: number;
  /** Refuse buffered growth once a session's in-memory file bytes exceed this. */
  maxSessionBufferBytes: number;
}

/** Built-in caps: generous for statements and payment files, bounded for the host. */
export const DEFAULT_SFTP_LIMITS: SftpSessionLimits = {
  maxFileBytes: 25 * 1024 * 1024,
  maxOpenHandles: 64,
  maxSessionBufferBytes: 128 * 1024 * 1024,
};

function envBytes(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Effective caps: explicit `SFTP_MAX_FILE_BYTES` / `SFTP_MAX_OPEN_HANDLES` /
 * `SFTP_MAX_SESSION_BUFFER_BYTES` env overrides, otherwise the built-ins.
 * Unparseable values fall back (a cap stays a cap — garbage never disables
 * one). The session buffer is floored at the file cap so a configured file
 * size is always usable for at least one open file. Read live (like the
 * storage backend's env reads) so tests and operators need no restart hook.
 */
export function sftpSessionLimits(): SftpSessionLimits {
  const maxFileBytes = envBytes("SFTP_MAX_FILE_BYTES", DEFAULT_SFTP_LIMITS.maxFileBytes);
  const maxOpenHandles = envBytes("SFTP_MAX_OPEN_HANDLES", DEFAULT_SFTP_LIMITS.maxOpenHandles);
  const maxSessionBufferBytes = Math.max(
    envBytes("SFTP_MAX_SESSION_BUFFER_BYTES", DEFAULT_SFTP_LIMITS.maxSessionBufferBytes),
    maxFileBytes,
  );
  return { maxFileBytes, maxOpenHandles, maxSessionBufferBytes };
}

const S_IFDIR = 0o40000, S_IFREG = 0o100000;

function attrsFor(isDir: boolean, size: number, mtimeMs: number) {
  return { mode: (isDir ? S_IFDIR | 0o755 : S_IFREG | 0o644), size, uid: 0, gid: 0, atime: Math.floor(mtimeMs / 1000), mtime: Math.floor(mtimeMs / 1000) };
}
function longname(name: string, isDir: boolean, size: number): string {
  const perm = isDir ? "drwxr-xr-x" : "-rw-r--r--";
  return `${perm} 1 owner group ${String(size).padStart(12)} Jan  1 00:00 ${name}`;
}

/**
 * Which SFTP status a backend/storage throw becomes on the wire.
 *
 * A genuine absence reads NO_SUCH_FILE; a permission refusal reads
 * PERMISSION_DENIED; everything else — an S3 outage or timeout, a disk
 * error, a path that exists but is not a file — reads FAILURE, never a
 * phantom "absent" that tells a bank client its file is gone when storage
 * is down. The FAILURE cause is logged server-side (see fail()); the
 * client gets the operation name and the error class, never server paths.
 */
export function sftpStatusForError(e: unknown): number {
  const err = e as {
    code?: unknown;
    name?: unknown;
    message?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  } | null | undefined;
  const code = typeof err?.code === "string" ? err.code : "";
  const name = typeof err?.name === "string" ? err.name : "";
  const message = typeof err?.message === "string" ? err.message : "";
  const httpStatus =
    err?.$metadata != null && typeof err.$metadata.httpStatusCode === "number"
      ? err.$metadata.httpStatusCode
      : null;
  if (
    /path escapes root|permission denied/i.test(message) ||
    /^(EACCES|EPERM)$/i.test(code) ||
    httpStatus === 403 ||
    /AccessDenied/i.test(`${code} ${name}`)
  ) {
    return STATUS_CODE.PERMISSION_DENIED;
  }
  if (
    /^ENOENT$/i.test(code) ||
    httpStatus === 404 ||
    /(^|[^a-z])NoSuchKey([^a-z]|$)|(^|[^a-z])NotFound([^a-z]|$)|no such file/i.test(
      `${code} ${name} ${message}`,
    )
  ) {
    return STATUS_CODE.NO_SUCH_FILE;
  }
  return STATUS_CODE.FAILURE;
}

/**
 * Client-facing message for a FAILURE-classified error: the operation and
 * the error class plus the retry/remedy wording. Server paths stay in the
 * server log, never on the wire.
 */
export function sftpFailureMessage(e: unknown, what: string): string {
  const err = e as { code?: unknown; name?: unknown } | null | undefined;
  const kind =
    (typeof err?.code === "string" && err.code) ||
    (typeof err?.name === "string" && err.name) ||
    "storage error";
  return `${what} failed (${kind}) — retry the operation, and ask your administrator if it persists`;
}

/** Generate a fresh ed25519 host key PEM (persist it so the fingerprint is stable). */
export function generateHostKey(): string {
  // ssh2's DER conversion strips leading zero bytes from Ed25519 public keys.
  // Rare generated keys therefore fail its own OpenSSH parser. Validate before
  // persisting a daemon identity; do not store a key that cannot start a server.
  for (let attempt = 0; attempt < 8; attempt++) {
    const { private: priv } = utils.generateKeyPairSync("ed25519");
    const parsed = utils.parseKey(priv);
    if (!(parsed instanceof Error) && parsed.type === "ssh-ed25519") return priv;
  }
  throw new Error("Could not generate a valid SFTP host key");
}

export interface SftpServerHandle {
  close(): Promise<void>;
  port: number;
  /**
   * End every live connection authenticated as this server id, promptly.
   * Same-process promptness for a revocation the PATCH route just committed;
   * the per-operation fence below is the authority that also covers
   * listeners in other processes. Unknown ids are a no-op.
   */
  revoke(serverId: string): void;
}

export function startSftpServer(opts: { port: number; hostKey: string; resolve: SftpResolver; limits?: Partial<SftpSessionLimits> }): Promise<SftpServerHandle> {
  const limits: SftpSessionLimits = { ...sftpSessionLimits(), ...opts.limits };
  // Same floor as the env resolution: one open file must always fit.
  limits.maxSessionBufferBytes = Math.max(limits.maxSessionBufferBytes, limits.maxFileBytes);
  // Live connections by authenticated server id, for prompt same-process
  // revocation. The per-operation fence is the authority (it also covers a
  // listener in another process); this registry only hurries the local end.
  const liveByServer = new Map<string, Set<Connection>>();
  const server = new Server({ hostKeys: [opts.hostKey] }, (client: Connection) => {
    let config: SftpServerConfig | null = null;
    client.on("authentication", async (ctx) => {
      try {
        if (ctx.method === "password") {
          config = await opts.resolve.password(ctx.username, ctx.password);
          // The password check already proved possession; record the login
          // before accepting, so a bookkeeping failure rejects instead of
          // accepting an unrecorded session.
          if (config) {
            try { await opts.resolve.loginSucceeded?.(config); }
            catch { config = null; }
          }
        } else if (ctx.method === "publickey" && opts.resolve.publicKey) {
          config = await opts.resolve.publicKey(ctx.username, ctx.key.algo, ctx.key.data);
          if (config) {
            // The unsigned probe only asks whether the key would be
            // accepted: it must never record a connection. Anyone holding
            // the public username and key can send one without the private
            // key, and the signed attempt that follows may still fail.
            if (ctx.signature === undefined) return ctx.accept(); // pubkey probe

            // ssh2 deliberately leaves public-key signature verification to the
            // application.  The resolver only establishes that this public key
            // is authorized; the signed request must still prove possession of
            // the corresponding private key before the session is accepted —
            // and only that verified accept records the connection.
            const parsedKey = utils.parseKey(ctx.key.data);
            if (parsedKey instanceof Error || !ctx.blob
                || parsedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) {
              config = null;
            } else {
              try { await opts.resolve.loginSucceeded?.(config); }
              catch { config = null; }
            }
          }
        }
      } catch { config = null; }
      if (config) ctx.accept();
      else ctx.reject(["password", "publickey"]);
    });

    client.on("ready", () => {
      // Authenticated: track the connection under its server id until it closes.
      const id = config!.id;
      let set = liveByServer.get(id);
      if (!set) liveByServer.set(id, (set = new Set()));
      set.add(client);
      client.on("close", () => {
        const tracked = liveByServer.get(id);
        if (tracked) {
          tracked.delete(client);
          if (tracked.size === 0) liveByServer.delete(id);
        }
      });
      client.on("session", (acceptSession) => {
        const session = acceptSession();
        session.on("sftp", (acceptSftp) => {
          const sftp = acceptSftp();
          const backend = backendFor(config!);
          const readOnlyDirs = config!.readOnlyDirs;
          const files = new Map<string, OpenFile>();
          const dirs = new Map<string, OpenDir>();
          let handleSeq = 0;
          const newHandle = () => Buffer.from(String(++handleSeq));

          // Backend/storage failures reach the client honestly: absence reads
          // absent, permission reads permission, and anything else (an S3
          // outage, a timeout, a disk error) reads FAILURE with the cause
          // logged server-side — never a phantom NO_SUCH_FILE.
          const fail = (reqid: number, e: unknown, what: string) => {
            const status = sftpStatusForError(e);
            if (status === STATUS_CODE.FAILURE) {
              console.error(`[sftp] ${what} failed:`, e);
              sftp.status(reqid, status, sftpFailureMessage(e, what));
              return;
            }
            sftp.status(reqid, status);
          };
          // A mutation of a system-published payment path is refused with
          // PERMISSION_DENIED — never executed, and never disguised as
          // NO_SUCH_FILE. Reads and stat stay allowed.
          const isPublished = (p: string) => isProtectedSftpPath(readOnlyDirs, p);
          const denyPublished = (reqid: number, p: string): boolean => {
            if (isPublished(p)) {
              sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
              return true;
            }
            return false;
          };

          // In-memory bytes held by this session's open files. Every refusal
          // below fires BEFORE the allocation or read it guards.
          let sessionBufferedBytes = 0;
          const overHandleCap = () => files.size + dirs.size >= limits.maxOpenHandles;
          const handleCapRefusal = `too many open files (limit ${limits.maxOpenHandles} per session); close a handle and retry`;

          // Authoritative per-operation liveness fence: the session's config
          // is re-validated against the resolver before EVERY operation, so
          // a disable or credential rotation takes effect on the next request
          // — no matter which process serves this listener, and no matter how
          // long the connection has been held. A resolver without
          // checkSession keeps every session alive. Failures fail closed: a
          // fence that errors refuses, and the revoked connection is ended
          // promptly because none of its further operations can succeed.
          const checkAlive = async (reqid: number): Promise<boolean> => {
            const check = opts.resolve.checkSession;
            if (!check) return true;
            let live: SessionLiveness;
            try {
              live = await check(config!);
            } catch {
              live = { alive: false, reason: "sftp login could not be re-validated; reconnect" };
            }
            if (live.alive) return true;
            sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED, live.reason);
            client.end();
            return false;
          };

          // Single choke point for the liveness fence: EVERY operation
          // handler below is registered through fenced(), so a new handler
          // cannot skip the check the way RMDIR did — after a disable or
          // credential rotation, the session's next request of ANY kind is
          // refused and the connection ends.
          const fenced = <A extends unknown[]>(
            handler: (reqid: number, ...args: A) => Promise<void> | void,
          ): ((reqid: number, ...args: A) => Promise<void>) => {
            return async (reqid: number, ...args: A) => {
              if (!(await checkAlive(reqid))) return;
              await handler(reqid, ...args);
            };
          };

          sftp.on("REALPATH", fenced(async (reqid: number, p: string) => {
            const cp = cleanPath(p === "." || p === "" ? "/" : p);
            sftp.name(reqid, [{ filename: cp, longname: longname(cp, true, 0), attrs: attrsFor(true, 0, Date.now()) }]);
          }));

          const doStat = fenced(async (reqid: number, p: string) => {
            try {
              // In-flight publishes are invisible to bank clients: report the
              // temp pattern as absent, exactly like a name that was never
              // written, so no client can stat, size, or time a partial file.
              if (isSftpTempName(p)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
              const st = await backend.stat(p);
              if (!st) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
              sftp.attrs(reqid, attrsFor(st.isDir, st.size, st.mtimeMs));
            } catch (e) { fail(reqid, e, "stat"); }
          });
          sftp.on("STAT", doStat);
          sftp.on("LSTAT", doStat);
          sftp.on("FSTAT", fenced(async (reqid: number, handle: Buffer) => {
            const f = files.get(handle.toString());
            if (!f) return sftp.status(reqid, STATUS_CODE.FAILURE);
            sftp.attrs(reqid, attrsFor(false, f.buf.length, Date.now()));
          }));

          sftp.on("OPENDIR", fenced(async (reqid: number, p: string) => {
            if (overHandleCap()) return sftp.status(reqid, STATUS_CODE.FAILURE, handleCapRefusal);
            try {
              // Temp siblings of in-flight publishes never appear in a bank
              // client's listing: without this, a client enumerating the
              // outbound folder mid-publish could open the partial bytes by
              // name (the OPEN guard below is the second half).
              const entries = (await backend.list(p)).filter((e) => !isSftpTempName(e.name));
              const h = newHandle();
              dirs.set(h.toString(), { entries, next: 0 });
              sftp.handle(reqid, h);
            } catch (e) { fail(reqid, e, "list"); }
          }));
          sftp.on("READDIR", fenced(async (reqid: number, handle: Buffer) => {
            const d = dirs.get(handle.toString());
            if (!d) return sftp.status(reqid, STATUS_CODE.FAILURE);
            if (d.next >= d.entries.length) return sftp.status(reqid, STATUS_CODE.EOF);
            const batch: typeof d.entries = [];
            let bytes = 0;
            while (d.next < d.entries.length && batch.length < MAX_READDIR_ENTRIES) {
              const e = d.entries[d.next]!;
              // Estimated encoded size of this name in the reply packet:
              // filename + longname bytes plus attribute overhead.
              const estimate = Buffer.byteLength(e.name) + Buffer.byteLength(longname(e.name, e.isDir, e.size)) + 64;
              if (batch.length > 0 && bytes + estimate > MAX_READDIR_BYTES) break;
              batch.push(e);
              bytes += estimate;
              d.next++;
            }
            sftp.name(reqid, batch.map((e) => ({ filename: e.name, longname: longname(e.name, e.isDir, e.size), attrs: attrsFor(e.isDir, e.size, e.mtimeMs) })));
          }));

          sftp.on("OPEN", fenced(async (reqid: number, filename: string, flags: number) => {
            // Neither reading a partial publish nor squatting its temp name:
            // both directions report the temp pattern as absent.
            if (isSftpTempName(filename)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            if (overHandleCap()) return sftp.status(reqid, STATUS_CODE.FAILURE, handleCapRefusal);
            // Published bank files are read-only over SFTP: any open that
            // could create, truncate, overwrite, or append is refused before
            // a handle exists. The app publishes through its own backend,
            // never through a session, so no legitimate flow opens these
            // paths for writing.
            const writing = !!(flags & (OPEN_MODE.WRITE | OPEN_MODE.CREAT | OPEN_MODE.TRUNC));
            if (writing || (flags & OPEN_MODE.APPEND)) {
              if (denyPublished(reqid, filename)) return;
            }
            const h = newHandle();
            // A file that already exceeds the per-file cap is refused BEFORE
            // it is read into the session: stat first, read only when it fits.
            const refuseOverCap = (size: number) => {
              if (size <= limits.maxFileBytes) return false;
              sftp.status(reqid, STATUS_CODE.FAILURE, `file is ${size} bytes, exceeding the ${limits.maxFileBytes}-byte per-file SFTP limit`);
              return true;
            };
            // A buffer that would push the session past its total is refused
            // BEFORE it is read: stacked large OPENs cannot pool memory.
            const refuseOverSession = (size: number) => {
              if (sessionBufferedBytes + size <= limits.maxSessionBufferBytes) return false;
              sftp.status(reqid, STATUS_CODE.FAILURE, `opening ${size} more bytes would exceed the ${limits.maxSessionBufferBytes}-byte per-session SFTP buffer limit; close a file and retry`);
              return true;
            };
            try {
              if (writing) {
                const path = cleanPath(filename);
                let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
                if (!(flags & OPEN_MODE.TRUNC)) {
                  const st = await backend.stat(path);
                  if (st) {
                    if (st.isDir) throw new Error("cannot open directory for writing");
                    if (!st.isDir && refuseOverCap(st.size)) return;
                    buf = await backend.read(path);
                  } else if (!(flags & OPEN_MODE.CREAT)) {
                    throw new Error("no such file");
                  }
                }
                if (refuseOverSession(buf.length)) return;
                sessionBufferedBytes += buf.length;
                files.set(h.toString(), {
                  path,
                  backend,
                  write: true,
                  append: !!(flags & OPEN_MODE.APPEND),
                  buf,
                });
              } else {
                const st = await backend.stat(filename);
                if (st && !st.isDir && refuseOverCap(st.size)) return;
                // Missing names and directories fall through to the read so
                // the failure shape stays exactly what it was before the cap.
                const buf = await backend.read(filename);
                if (refuseOverCap(buf.length)) return;
                if (refuseOverSession(buf.length)) return;
                sessionBufferedBytes += buf.length;
                files.set(h.toString(), { path: cleanPath(filename), backend, write: false, append: false, buf });
              }
              sftp.handle(reqid, h);
            } catch (e) { fail(reqid, e, "open"); }
          }));
          sftp.on("READ", fenced(async (reqid: number, handle: Buffer, offset: number, length: number) => {
            const f = files.get(handle.toString());
            if (!f || f.write) return sftp.status(reqid, STATUS_CODE.FAILURE);
            if (offset >= f.buf.length) return sftp.status(reqid, STATUS_CODE.EOF);
            sftp.data(reqid, f.buf.subarray(offset, Math.min(offset + length, f.buf.length)));
          }));
          sftp.on("WRITE", fenced(async (reqid: number, handle: Buffer, offset: number, data: Buffer) => {
            const f = files.get(handle.toString());
            if (!f || !f.write) return sftp.status(reqid, STATUS_CODE.FAILURE);
            const position = f.append ? f.buf.length : Number(offset);
            if (!Number.isSafeInteger(position) || position < 0 || position + data.length > 0xFFFFFFFF) {
              return sftp.status(reqid, STATUS_CODE.FAILURE);
            }
            // Sparse offsets and growth past the per-file cap refuse BEFORE
            // Buffer.alloc: a 1-byte write at a ~4 GiB offset must never
            // gap-fill a 4 GiB buffer in the shared web process.
            const end = position + data.length;
            if (end > limits.maxFileBytes) {
              return sftp.status(reqid, STATUS_CODE.FAILURE, `write would grow the file to ${end} bytes, exceeding the ${limits.maxFileBytes}-byte per-file SFTP limit`);
            }
            const growth = Math.max(0, end - f.buf.length);
            if (sessionBufferedBytes + growth > limits.maxSessionBufferBytes) {
              return sftp.status(reqid, STATUS_CODE.FAILURE, `write would exceed the ${limits.maxSessionBufferBytes}-byte per-session SFTP buffer limit; close a file and retry`);
            }
            try {
              if (end > f.buf.length) {
                const next = Buffer.alloc(end);
                f.buf.copy(next);
                f.buf = next;
                sessionBufferedBytes += growth;
              }
              Buffer.from(data).copy(f.buf, position);
              sftp.status(reqid, STATUS_CODE.OK);
            } catch {
              sftp.status(reqid, STATUS_CODE.FAILURE);
            }
          }));
          sftp.on("CLOSE", fenced(async (reqid: number, handle: Buffer) => {
            const key = handle.toString();
            const f = files.get(key);
            if (f) {
              files.delete(key);
              sessionBufferedBytes = Math.max(0, sessionBufferedBytes - f.buf.length);
              if (f.write) {
                // Fail-closed on the storage write: the OPEN/WRITE guards
                // above make this unreachable, but an over-cap buffer must
                // never be persisted even if a guard is ever bypassed.
                if (f.buf.length > limits.maxFileBytes) {
                  return sftp.status(reqid, STATUS_CODE.FAILURE, `file is ${f.buf.length} bytes, exceeding the ${limits.maxFileBytes}-byte per-file SFTP limit and cannot be saved`);
                }
                try { await backend.write(f.path, f.buf); }
                catch (e) { return fail(reqid, e, "save"); }
              }
            } else dirs.delete(key);
            sftp.status(reqid, STATUS_CODE.OK);
          }));

          // Deleting or moving an in-flight publish's temp sibling would
          // break the atomic rename the writer is about to perform, so temp
          // names refuse here exactly as they do for open and stat.
          const wrap = (what: string, op: (p: string) => Promise<void>) => fenced(async (reqid: number, p: string) => {
            try {
              if (isSftpTempName(p)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
              if (denyPublished(reqid, p)) return;
              await op(p); sftp.status(reqid, STATUS_CODE.OK);
            } catch (e) { fail(reqid, e, what); }
          });
          sftp.on("REMOVE", wrap("remove", (p) => backend.remove(p)));
          sftp.on("MKDIR", wrap("make folder", (p) => backend.mkdir(p)));
          sftp.on("RMDIR", fenced(async (reqid: number, p: string) => {
            try {
              if (isSftpTempName(p)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
              if (denyPublished(reqid, p)) return;
              await backend.rmdir(p);
              sftp.status(reqid, STATUS_CODE.OK);
            } catch (e) {
              // A populated folder refuses with FAILURE and its reason —
              // never a phantom success, never a misleading NO_SUCH_FILE.
              if (e instanceof SftpDirectoryNotEmptyError) return sftp.status(reqid, STATUS_CODE.FAILURE, e.message);
              fail(reqid, e, "remove folder");
            }
          }));
          sftp.on("RENAME", fenced(async (reqid: number, from: string, to: string) => {
            try {
              if (isSftpTempName(from) || isSftpTempName(to)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
              if (denyPublished(reqid, from) || denyPublished(reqid, to)) return;
              await backend.rename(from, to); sftp.status(reqid, STATUS_CODE.OK);
            } catch (e) { fail(reqid, e, "rename"); }
          }));
          // Attribute mutation is not implemented and SftpBackend exposes no
          // attribute-update method, so SETSTAT/FSETSTAT must refuse instead
          // of answering OK: an OK for a no-op tells a partner its
          // SETSTAT(size=0) cleared a mistaken upload while the original
          // bytes still post, and makes chmod/mtime look accepted while
          // ignored. OP_UNSUPPORTED names the refusal; a future
          // implementation must apply attributes atomically through the
          // backend (especially size/truncate) before answering OK.
          // A system-published payment path refuses with PERMISSION_DENIED
          // after the liveness fence, so the published artifact's protection
          // does not depend on which refusal the generic path carries — and
          // a revoked session is ended before it can probe anything.
          sftp.on("SETSTAT", fenced(async (reqid: number, p: string) => {
            if (denyPublished(reqid, p)) return;
            sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED, "SETSTAT is not supported: attributes cannot be changed; re-upload the file instead");
          }));
          sftp.on("FSETSTAT", fenced(async (reqid: number, handle: Buffer) => {
            const f = files.get(handle.toString());
            if (f && denyPublished(reqid, f.path)) return;
            sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED, "FSETSTAT is not supported: attributes cannot be changed; re-upload the file instead");
          }));
          // The backend has no symlink concept, so these can never succeed —
          // but they still go through the fence. Without an explicit handler
          // ssh2 answers OP_UNSUPPORTED itself, which would let a revoked
          // session probe request types without ever hitting the fence.
          sftp.on("SYMLINK", fenced(async (reqid: number) => {
            sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED, "symlinks are not supported");
          }));
          sftp.on("READLINK", fenced(async (reqid: number) => {
            sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED, "symlinks are not supported");
          }));
          sftp.on("EXTENDED", fenced(async (reqid: number) => {
            sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED, "extended requests are not supported");
          }));
        });
      });
    });
    client.on("error", () => {});
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(opts.port, "0.0.0.0", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        close: () => new Promise<void>((res) => {
          liveByServer.clear();
          server.close(() => res());
        }),
        revoke: (serverId: string) => {
          const tracked = liveByServer.get(serverId);
          if (!tracked) return;
          for (const conn of [...tracked]) {
            try {
              conn.end();
            } catch {
              // A half-closed socket refuses nothing: the fence ends it on
              // its next operation, and 'close' untracks it either way.
            }
          }
        },
      });
    });
  });
}
