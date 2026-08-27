import ssh2 from "ssh2";
import type { Connection } from "ssh2";
import { backendFor, cleanPath, type SftpBackend } from "./backend.ts";

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
}

export interface SftpResolver {
  /** Return the server config if the password authenticates this login. */
  password(username: string, password: string): Promise<SftpServerConfig | null>;
  /** Return the server config if the public key authenticates this login. */
  publicKey?(username: string, keyAlgo: string, keyData: Buffer): Promise<SftpServerConfig | null>;
}

interface OpenFile { path: string; backend: SftpBackend; write: boolean; buf: Buffer; chunks: Buffer[] }
interface OpenDir { entries: { name: string; isDir: boolean; size: number; mtimeMs: number }[]; sent: boolean }

const S_IFDIR = 0o40000, S_IFREG = 0o100000;

function attrsFor(isDir: boolean, size: number, mtimeMs: number) {
  return { mode: (isDir ? S_IFDIR | 0o755 : S_IFREG | 0o644), size, uid: 0, gid: 0, atime: Math.floor(mtimeMs / 1000), mtime: Math.floor(mtimeMs / 1000) };
}
function longname(name: string, isDir: boolean, size: number): string {
  const perm = isDir ? "drwxr-xr-x" : "-rw-r--r--";
  return `${perm} 1 owner group ${String(size).padStart(12)} Jan  1 00:00 ${name}`;
}

/** Generate a fresh ed25519 host key PEM (persist it so the fingerprint is stable). */
export function generateHostKey(): string {
  const { private: priv } = utils.generateKeyPairSync("ed25519");
  return priv;
}

export interface SftpServerHandle {
  close(): Promise<void>;
  port: number;
}

export function startSftpServer(opts: { port: number; hostKey: string; resolve: SftpResolver }): Promise<SftpServerHandle> {
  const server = new Server({ hostKeys: [opts.hostKey] }, (client: Connection) => {
    let config: SftpServerConfig | null = null;
    client.on("authentication", async (ctx) => {
      try {
        if (ctx.method === "password") config = await opts.resolve.password(ctx.username, ctx.password);
        else if (ctx.method === "publickey" && opts.resolve.publicKey) {
          config = await opts.resolve.publicKey(ctx.username, ctx.key.algo, ctx.key.data);
          if (config && ctx.signature === undefined) return ctx.accept(); // pubkey probe
        }
      } catch { config = null; }
      config ? ctx.accept() : ctx.reject(["password", "publickey"]);
    });

    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        const session = acceptSession();
        session.on("sftp", (acceptSftp) => {
          const sftp = acceptSftp();
          const backend = backendFor(config!);
          const files = new Map<string, OpenFile>();
          const dirs = new Map<string, OpenDir>();
          let handleSeq = 0;
          const newHandle = () => Buffer.from(String(++handleSeq));

          const fail = (reqid: number, e: unknown) => {
            const msg = (e as { name?: string })?.name;
            sftp.status(reqid, msg === "path escapes root" ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.NO_SUCH_FILE);
          };

          sftp.on("REALPATH", (reqid, p) => {
            const cp = cleanPath(p === "." || p === "" ? "/" : p);
            sftp.name(reqid, [{ filename: cp, longname: longname(cp, true, 0), attrs: attrsFor(true, 0, Date.now()) }]);
          });

          const doStat = async (reqid: number, p: string) => {
            try {
              const st = await backend.stat(p);
              if (!st) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
              sftp.attrs(reqid, attrsFor(st.isDir, st.size, st.mtimeMs));
            } catch (e) { fail(reqid, e); }
          };
          sftp.on("STAT", doStat);
          sftp.on("LSTAT", doStat);
          sftp.on("FSTAT", (reqid, handle) => {
            const f = files.get(handle.toString());
            if (!f) return sftp.status(reqid, STATUS_CODE.FAILURE);
            sftp.attrs(reqid, attrsFor(false, f.write ? 0 : f.buf.length, Date.now()));
          });

          sftp.on("OPENDIR", async (reqid, p) => {
            try {
              const entries = await backend.list(p);
              const h = newHandle();
              dirs.set(h.toString(), { entries, sent: false });
              sftp.handle(reqid, h);
            } catch (e) { fail(reqid, e); }
          });
          sftp.on("READDIR", (reqid, handle) => {
            const d = dirs.get(handle.toString());
            if (!d) return sftp.status(reqid, STATUS_CODE.FAILURE);
            if (d.sent) return sftp.status(reqid, STATUS_CODE.EOF);
            d.sent = true;
            sftp.name(reqid, d.entries.map((e) => ({ filename: e.name, longname: longname(e.name, e.isDir, e.size), attrs: attrsFor(e.isDir, e.size, e.mtimeMs) })));
          });

          sftp.on("OPEN", async (reqid, filename, flags) => {
            const writing = !!(flags & (OPEN_MODE.WRITE | OPEN_MODE.CREAT | OPEN_MODE.TRUNC));
            const h = newHandle();
            try {
              if (writing) {
                files.set(h.toString(), { path: cleanPath(filename), backend, write: true, buf: Buffer.alloc(0), chunks: [] });
              } else {
                const buf = await backend.read(filename);
                files.set(h.toString(), { path: cleanPath(filename), backend, write: false, buf, chunks: [] });
              }
              sftp.handle(reqid, h);
            } catch (e) { fail(reqid, e); }
          });
          sftp.on("READ", (reqid, handle, offset, length) => {
            const f = files.get(handle.toString());
            if (!f || f.write) return sftp.status(reqid, STATUS_CODE.FAILURE);
            if (offset >= f.buf.length) return sftp.status(reqid, STATUS_CODE.EOF);
            sftp.data(reqid, f.buf.subarray(offset, Math.min(offset + length, f.buf.length)));
          });
          sftp.on("WRITE", (reqid, handle, _offset, data) => {
            const f = files.get(handle.toString());
            if (!f || !f.write) return sftp.status(reqid, STATUS_CODE.FAILURE);
            f.chunks.push(Buffer.from(data));
            sftp.status(reqid, STATUS_CODE.OK);
          });
          sftp.on("CLOSE", async (reqid, handle) => {
            const key = handle.toString();
            const f = files.get(key);
            if (f) {
              files.delete(key);
              if (f.write) {
                try { await backend.write(f.path, Buffer.concat(f.chunks)); }
                catch (e) { return fail(reqid, e); }
              }
            } else dirs.delete(key);
            sftp.status(reqid, STATUS_CODE.OK);
          });

          const wrap = (op: (p: string) => Promise<void>) => async (reqid: number, p: string) => {
            try { await op(p); sftp.status(reqid, STATUS_CODE.OK); } catch (e) { fail(reqid, e); }
          };
          sftp.on("REMOVE", wrap((p) => backend.remove(p)));
          sftp.on("MKDIR", wrap((p) => backend.mkdir(p)));
          sftp.on("RMDIR", wrap((p) => backend.rmdir(p)));
          sftp.on("RENAME", async (reqid, from, to) => {
            try { await backend.rename(from, to); sftp.status(reqid, STATUS_CODE.OK); } catch (e) { fail(reqid, e); }
          });
          sftp.on("SETSTAT", (reqid) => sftp.status(reqid, STATUS_CODE.OK));
          sftp.on("FSETSTAT", (reqid) => sftp.status(reqid, STATUS_CODE.OK));
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
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}
