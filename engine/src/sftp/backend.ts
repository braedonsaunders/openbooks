import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { env } from "../db.ts";

/**
 * Storage backend for the built-in SFTP server. Two implementations, mirroring
 * web/lib/file-storage.ts:
 *   - 's3'    → an S3-compatible object store (MinIO in the dev deployment).
 *   - 'local' → a directory on disk (zero-config dev + verification).
 *
 * The SFTP daemon maps each virtual server's session to a backend rooted at its
 * bucket/prefix (S3) or subfolder (local). Directories are POSIX paths relative
 * to that root; the S3 backend models them as key prefixes with `/` markers.
 */

export interface SftpEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

export interface SftpBackend {
  list(dir: string): Promise<SftpEntry[]>;
  stat(p: string): Promise<Omit<SftpEntry, "name"> | null>;
  read(p: string): Promise<Buffer>;
  write(p: string, data: Buffer): Promise<void>;
  remove(p: string): Promise<void>;
  mkdir(p: string): Promise<void>;
  rmdir(p: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

/** Normalize an SFTP path to a clean, root-relative POSIX path (no `..` escape). */
export function cleanPath(p: string): string {
  const norm = path.posix.normalize("/" + p).replace(/\/+$/, "");
  return norm === "" ? "/" : norm;
}

// --------------------------------------------------------------------------
// Local filesystem backend
// --------------------------------------------------------------------------

export function localBackend(rootDir: string): SftpBackend {
  const abs = (p: string) => {
    const rel = cleanPath(p).replace(/^\//, "");
    const full = path.resolve(rootDir, rel);
    if (full !== rootDir && !full.startsWith(rootDir + path.sep)) throw new Error("path escapes root");
    return full;
  };
  return {
    async list(dir) {
      const entries = await fs.readdir(abs(dir), { withFileTypes: true }).catch((e) => {
        if ((e as { code?: string }).code === "ENOENT") return [];
        throw e;
      });
      const out: SftpEntry[] = [];
      for (const e of entries) {
        const st = await fs.stat(path.join(abs(dir), e.name)).catch(() => null);
        if (!st) continue;
        out.push({ name: e.name, isDir: e.isDirectory(), size: st.size, mtimeMs: st.mtimeMs });
      }
      return out;
    },
    async stat(p) {
      if (cleanPath(p) === "/") return { isDir: true, size: 0, mtimeMs: Date.now() };
      const st = await fs.stat(abs(p)).catch(() => null);
      if (!st) return null;
      return { isDir: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs };
    },
    async read(p) {
      return fs.readFile(abs(p));
    },
    async write(p, data) {
      const full = abs(p);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, data);
    },
    async remove(p) {
      await fs.unlink(abs(p));
    },
    async mkdir(p) {
      await fs.mkdir(abs(p), { recursive: true });
    },
    async rmdir(p) {
      await fs.rmdir(abs(p));
    },
    async rename(from, to) {
      const dest = abs(to);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(abs(from), dest);
    },
  };
}

// --------------------------------------------------------------------------
// S3 / MinIO backend
// --------------------------------------------------------------------------

let s3: S3Client | null = null;
function client(): S3Client {
  if (!s3) {
    s3 = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION || "us-east-1",
      credentials: { accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY! },
      forcePathStyle: true,
    });
  }
  return s3;
}

export function s3Backend(bucket: string, prefix: string, orgId: string): SftpBackend {
  const root = prefix.replace(/^\/+|\/+$/g, "");
  const tenantPrefix = sftpTenantPrefix(orgId);
  const key = (p: string) => {
    const rel = cleanPath(p).replace(/^\//, "");
    const full = [root, rel].filter(Boolean).join("/");
    // Defense in depth: every key this backend touches must stay inside the
    // owning tenant's namespace, whatever the session asked for.
    if (full !== tenantPrefix && !full.startsWith(tenantPrefix + "/")) {
      throw new Error("sftp s3 key escapes the tenant prefix");
    }
    return full;
  };
  const dirKey = (p: string) => {
    const k = key(p);
    return k ? k + "/" : "";
  };
  return {
    async list(dir) {
      const Prefix = dirKey(dir);
      const res = await client().send(new ListObjectsV2Command({ Bucket: bucket, Prefix, Delimiter: "/" }));
      const out: SftpEntry[] = [];
      for (const c of res.CommonPrefixes ?? []) {
        const name = c.Prefix!.slice(Prefix.length).replace(/\/$/, "");
        if (name) out.push({ name, isDir: true, size: 0, mtimeMs: Date.now() });
      }
      for (const o of res.Contents ?? []) {
        const name = o.Key!.slice(Prefix.length);
        if (!name || name.endsWith("/")) continue; // skip the folder marker itself
        out.push({ name, isDir: false, size: o.Size ?? 0, mtimeMs: (o.LastModified ?? new Date()).getTime() });
      }
      return out;
    },
    async stat(p) {
      const cp = cleanPath(p);
      if (cp === "/") return { isDir: true, size: 0, mtimeMs: Date.now() };
      try {
        const h = await client().send(new HeadObjectCommand({ Bucket: bucket, Key: key(p) }));
        return { isDir: false, size: h.ContentLength ?? 0, mtimeMs: (h.LastModified ?? new Date()).getTime() };
      } catch {
        // maybe a directory: any object under prefix?
        const res = await client().send(new ListObjectsV2Command({ Bucket: bucket, Prefix: dirKey(p), MaxKeys: 1 }));
        if ((res.KeyCount ?? 0) > 0) return { isDir: true, size: 0, mtimeMs: Date.now() };
        return null;
      }
    },
    async read(p) {
      const res = await client().send(new GetObjectCommand({ Bucket: bucket, Key: key(p) }));
      return Buffer.from(await res.Body!.transformToByteArray());
    },
    async write(p, data) {
      await client().send(new PutObjectCommand({ Bucket: bucket, Key: key(p), Body: data }));
    },
    async remove(p) {
      await client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key(p) }));
    },
    async mkdir(p) {
      await client().send(new PutObjectCommand({ Bucket: bucket, Key: dirKey(p), Body: Buffer.alloc(0) }));
    },
    async rmdir(p) {
      await client().send(new DeleteObjectCommand({ Bucket: bucket, Key: dirKey(p) }));
    },
    async rename(from, to) {
      await client().send(new CopyObjectCommand({ Bucket: bucket, CopySource: `${bucket}/${key(from)}`, Key: key(to) }));
      await client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key(from) }));
    },
  };
}

/** Where the local backend keeps files (no env required; a data dir under the app). */
function localRoot(): string {
  return env.OPENBOOKS_DATA_DIR ? path.join(env.OPENBOOKS_DATA_DIR, "sftp") : path.join(process.cwd(), ".sftp-data");
}

/**
 * Which storage the app itself has available for SFTP files: the shared object
 * store when the app is configured for it, else local disk. This is the app's
 * own storage (same as the file cabinet), NOT a per-tenant/per-SFTP setting —
 * tenants just create a server in the UI and get a folder under their prefix.
 */
export function appStorageKind(): "s3" | "local" {
  return env.S3_ENDPOINT && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY && env.S3_BUCKET ? "s3" : "local";
}
export function appBucket(): string | null {
  return env.S3_BUCKET ?? null;
}

/**
 * Physical storage config for one virtual SFTP server. `orgId` is REQUIRED:
 * the physical root is always derived from (or validated against) the owning
 * tenant's namespace — a stored prefix alone is never trusted, because a
 * direct or stale row could otherwise point anywhere in the shared bucket or
 * on disk.
 */
export interface SftpServerStorageConfig {
  backend: string; // 's3' | 'local'
  bucket: string | null;
  rootPrefix: string;
  orgId: string;
}

/** The tenant namespace every SFTP root must live under: `sftp/<orgId>`. */
export function sftpTenantPrefix(orgId: string): string {
  return `sftp/${orgId}`;
}

/**
 * Fail-closed shape guard for a root prefix: a tenant may name folders, never
 * physical locations. Rejects empty prefixes, absolute paths, backslashes,
 * percent-encoding (a `%2e%2e` traversal must never reach the backend) and
 * empty or dot segments. Returns the prefix unchanged — nothing is silently
 * rewritten into validity.
 */
export function assertSafeRootPrefix(rootPrefix: string): string {
  const raw = typeof rootPrefix === "string" ? rootPrefix : "";
  if (raw === "") throw new Error("sftp root prefix must not be empty");
  if (raw.includes("\\")) throw new Error("sftp root prefix must not contain backslashes");
  if (raw.includes("%")) throw new Error("sftp root prefix must not contain percent-encoding");
  if (raw.startsWith("/")) throw new Error("sftp root prefix must be a relative path");
  if (raw.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("sftp root prefix must not contain empty or dot segments");
  }
  return raw;
}

/**
 * Tenant binding for a root prefix: it must stay inside the owning org's
 * `sftp/<orgId>` namespace (exactly that root or deeper). A cross-tenant
 * prefix is refused exactly like a traversal. Returns the validated prefix.
 */
export function assertTenantRootPrefix(rootPrefix: string, orgId: string): string {
  if (!orgId) throw new Error("sftp root prefix requires the owning org id");
  const safe = assertSafeRootPrefix(rootPrefix);
  const tenantPrefix = sftpTenantPrefix(orgId);
  if (safe !== tenantPrefix && !safe.startsWith(tenantPrefix + "/")) {
    throw new Error(`sftp root prefix must stay under ${tenantPrefix}/`);
  }
  return safe;
}

/**
 * Pick a backend for a virtual server. 's3' when configured, else a local dir.
 * The resolver is authoritative for direct/stale rows: the prefix is validated
 * against the owning tenant (S3 keys stay under `sftp/<orgId>`; the local root
 * stays under the data root) and any violation fails closed before the first
 * storage operation.
 */
export function backendFor(server: SftpServerStorageConfig): SftpBackend {
  if (!server.orgId) throw new Error("sftp server config is missing its owning org id");
  const rootPrefix = assertSafeRootPrefix(server.rootPrefix);
  if (server.backend === "s3") {
    if (!server.bucket) throw new Error("s3 sftp server missing bucket");
    return s3Backend(server.bucket, rootPrefix, server.orgId);
  }
  const dataRoot = path.resolve(localRoot());
  const resolved = path.resolve(dataRoot, rootPrefix);
  if (resolved !== dataRoot && !resolved.startsWith(dataRoot + path.sep)) {
    throw new Error("path escapes root");
  }
  return localBackend(resolved);
}
