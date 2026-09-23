import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

/** Unique suffix for an in-flight publish temp name (never reused, never cleaned by others). */
function randomSuffix(): string {
  return `${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
}

/** Best-effort directory fsync so the publish rename is durable, not only visible. */
async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await fs.open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Platforms that refuse directory fsync still have the atomic rename;
    // durability of the directory entry is a bonus, not the guarantee.
  }
}
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { env } from "../platform/db.ts";

/**
 * Storage backend for the built-in SFTP server. Two implementations:
 *   - 's3'    → an S3-compatible object store (MinIO in the dev deployment).
 *   - 'local' → a directory on disk, rooted at an explicitly configured
 *     absolute OPENBOOKS_DATA_DIR shared by the web and worker processes.
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

/**
 * Marker inside the file name of an in-flight local publish. `localBackend`
 * stages every write under a hidden sibling carrying this marker and renames
 * it onto the final name only after fsync, so a bank polling mid-write can
 * never fetch truncated bytes. The marker is part of the SFTP contract:
 * `server.ts` hides these names from listings and refuses to open, stat, or
 * delete them, and the import scan already skips dotfiles.
 */
export const SFTP_TEMP_WRITE_MARKER = ".sftp-part-";

/** Whether a backend-relative path (or bare name) names an in-flight publish. */
export function isSftpTempName(p: string): boolean {
  const base = p.split("/").pop() ?? p;
  return base.startsWith(".") && base.includes(SFTP_TEMP_WRITE_MARKER);
}

/**
 * A directory refused because it still holds objects. Carries the virtual
 * path (never a server absolute path) so the refusal names the folder for
 * the operator; the daemon maps it to the SFTP failure status rather than a
 * misleading NO_SUCH_FILE or a phantom success.
 */
export class SftpDirectoryNotEmptyError extends Error {
  constructor(virtualPath: string) {
    super(`sftp folder '${cleanPath(virtualPath)}' is not empty — move or delete its contents before removing it`);
    this.name = "SftpDirectoryNotEmptyError";
  }
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
      // Atomic publish: stage under a hidden temp sibling in the SAME
      // directory (same filesystem, so the rename is atomic), fsync the
      // content, then rename onto the final name. A concurrent reader —
      // through this backend or the SFTP daemon, which hides the temp
      // pattern — observes either the previous complete file or the new
      // complete file, never truncated bytes. The S3 backend needs none of
      // this: PutObject is already atomic. The temp name is unique per
      // write; only THIS write's temp is ever removed, and only on failure
      // (a crashed writer's temp stays hidden and harmless rather than
      // risking another in-flight publish during cleanup).
      const full = abs(p);
      await fs.mkdir(path.dirname(full), { recursive: true });
      const tmp = path.join(
        path.dirname(full),
        `.${path.basename(full)}${SFTP_TEMP_WRITE_MARKER}${process.pid}-${randomSuffix()}`,
      );
      try {
        const handle = await fs.open(tmp, "w");
        try {
          await handle.writeFile(data);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(tmp, full);
        await syncDir(path.dirname(full));
      } catch (e) {
        await fs.unlink(tmp).catch(() => {});
        throw e;
      }
    },
    async remove(p) {
      await fs.unlink(abs(p));
    },
    async mkdir(p) {
      await fs.mkdir(abs(p), { recursive: true });
    },
    async rmdir(p) {
      try {
        await fs.rmdir(abs(p));
      } catch (e) {
        // ENOTEMPTY names the server absolute path; refuse with the virtual
        // path instead, through the same named error the S3 backend throws.
        if ((e as { code?: string }).code === "ENOTEMPTY") throw new SftpDirectoryNotEmptyError(p);
        throw e;
      }
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
      // Credentials are read live: db.ts snapshots the environment at module evaluation.
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! },
      forcePathStyle: true,
    });
  }
  return s3;
}

/**
 * Test seam: substitute the shared S3 client (the network) so tests can
 * capture the exact commands the backend sends — including the serialized
 * CopySource header — without touching object storage. Pass null to restore
 * the real client. Never used outside tests.
 */
export function setSftpS3ClientForTests(replacement: S3Client | null): void {
  s3 = replacement;
}

/**
 * Build the `x-amz-copy-source` header value for an S3 rename: the bucket
 * plus the source key with every path segment URL-encoded (`/` separators
 * kept). The installed SDK sends CopySource verbatim, and AWS requires the
 * encoded form — a raw `b/a #1.ofx` renames nothing and the source file is
 * left behind to be re-scanned as a duplicate.
 */
export function encodeS3CopySource(bucket: string, sourceKey: string): string {
  const encodedKey = sourceKey
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${encodeURIComponent(bucket)}/${encodedKey}`;
}

export function s3Backend(bucket: string, prefix: string, orgId: string): SftpBackend {
  // Keep the exported constructor safe on its own as well as through
  // backendFor: every S3 backend must be rooted in its owning tenant.
  const root = assertTenantRootPrefix(prefix, orgId).replace(/^\/+|\/+$/g, "");
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
      // S3 has no directories: deleting only the zero-byte folder marker
      // would report success while the folder's statements still import.
      // Match fs.rmdir — refuse a non-empty prefix by name, and delete the
      // marker only when nothing sits under it.
      const marker = dirKey(p);
      const listed = await client().send(new ListObjectsV2Command({ Bucket: bucket, Prefix: marker, MaxKeys: 2 }));
      const hasChild = (listed.Contents ?? []).some((o) => o.Key !== marker);
      if (hasChild) throw new SftpDirectoryNotEmptyError(p);
      await client().send(new DeleteObjectCommand({ Bucket: bucket, Key: marker }));
    },
    async rename(from, to) {
      await client().send(new CopyObjectCommand({ Bucket: bucket, CopySource: encodeS3CopySource(bucket, key(from)), Key: key(to) }));
      await client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key(from) }));
    },
  };
}

/**
 * The four environment variables that together configure SFTP object storage.
 * All four set means S3; none set means local disk; anything in between is a
 * misconfiguration and refuses by name — never a silent local fallback.
 */
const SFTP_S3_VARS = ["S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET"] as const;

/**
 * Live read of one storage setting: process.env wins (values assigned after
 * module load), falling back to the engine env snapshot (db.ts mirrors the
 * resolved environment into both at boot, and tests hand that snapshot a
 * throwaway directory before importing this module).
 */
function sftpEnv(name: string): string | undefined {
  return process.env[name] ?? env[name];
}

/**
 * Absolute on-disk root for local SFTP storage. The listener runs in the web
 * process and the scheduled import runs in the worker, each with its own
 * working directory — so a cwd-relative root would give the two processes two
 * different folders, and uploads would never meet the importer. Local storage
 * therefore requires an explicitly configured ABSOLUTE OPENBOOKS_DATA_DIR
 * shared by both processes; anything else refuses by name.
 */
function localSftpRoot(): string {
  const dataDir = sftpEnv("OPENBOOKS_DATA_DIR");
  if (!dataDir) {
    throw new Error(
      "Local SFTP storage needs OPENBOOKS_DATA_DIR set to an absolute directory shared by the web and worker processes, or configure S3",
    );
  }
  if (!path.isAbsolute(dataDir)) {
    throw new Error(
      `Local SFTP storage needs OPENBOOKS_DATA_DIR to be an absolute directory shared by the web and worker processes (got '${dataDir}'), or configure S3`,
    );
  }
  return path.join(dataDir, "sftp");
}

export interface SftpStorageSelection {
  kind: "s3" | "local";
  bucket: string | null;
}

/**
 * Which storage the app itself has available for SFTP files: the shared
 * object store when the app is configured for it, else local disk under the
 * absolute shared OPENBOOKS_DATA_DIR. This is the app's own storage, NOT a
 * per-tenant/per-SFTP setting — tenants just create a server in the UI and
 * get a folder under their prefix.
 *
 * Fails closed: partial S3 configuration names the missing variable(s), and
 * local storage without an absolute shared root refuses — never a silent
 * per-process directory the other process cannot see.
 */
export function sftpStorageSelection(): SftpStorageSelection {
  const missing = SFTP_S3_VARS.filter((name) => !sftpEnv(name));
  if (missing.length > 0 && missing.length < SFTP_S3_VARS.length) {
    const plural = missing.length === 1 ? "is" : "are";
    throw new Error(
      `S3 is partly configured: ${missing.join(", ")} ${plural} missing — ` +
        `set the missing variable${missing.length === 1 ? "" : "s"} or unset all four S3 variables to use local SFTP storage`,
    );
  }
  if (missing.length === 0) return { kind: "s3", bucket: sftpEnv("S3_BUCKET")! };
  // Local only when no S3 variable is set at all AND an absolute shared root
  // exists; localSftpRoot refuses by name otherwise.
  localSftpRoot();
  return { kind: "local", bucket: null };
}

/**
 * Refuse-before-serving gate for local/S3 storage selection. The listener
 * calls this at start and every local backend resolution calls it per row, so
 * a misconfigured deployment is named at boot instead of silently splitting
 * uploads and imports across per-process directories.
 */
export function assertSftpStorageReady(): void {
  sftpStorageSelection();
}

export function appStorageKind(): "s3" | "local" {
  return sftpStorageSelection().kind;
}
export function appBucket(): string | null {
  return sftpStorageSelection().bucket;
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
  const rootPrefix = assertTenantRootPrefix(server.rootPrefix, server.orgId);
  if (server.backend === "s3") {
    if (!server.bucket) throw new Error("s3 sftp server missing bucket");
    // Fail closed on a broken object-store configuration: partial S3 throws
    // naming the missing variable(s); no S3 at all refuses instead of serving
    // an S3-rooted login from nowhere.
    const selection = sftpStorageSelection();
    if (selection.kind !== "s3") {
      throw new Error(
        "sftp server is configured for S3 but no S3 storage is configured — set S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY and S3_BUCKET",
      );
    }
    return s3Backend(server.bucket, rootPrefix, server.orgId);
  }
  // The shared root itself is validated here: without an absolute configured
  // root every local row refuses by name instead of landing in a
  // per-process directory the other process cannot see.
  const dataRoot = localSftpRoot();
  const resolved = path.resolve(dataRoot, rootPrefix);
  if (resolved !== dataRoot && !resolved.startsWith(dataRoot + path.sep)) {
    throw new Error("path escapes root");
  }
  return localBackend(resolved);
}
