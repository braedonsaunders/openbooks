import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

/**
 * Minimal in-memory S3 stand-in for SFTP backend tests: the network, not the
 * backend logic, is what's doubled. It stores versionless byte objects with
 * last-modified stamps and answers exactly the commands the SFTP backend
 * sends (PUT/GET/HEAD/DELETE/LIST/COPY). Every command sent is recorded on
 * `sent` so tests can assert the serialized wire form (e.g. the encoded
 * `CopySource` header).
 *
 * Three AWS behaviors are emulated because the backend depends on them:
 * - LIST with a Prefix returns every key under that prefix, INCLUDING the
 *   zero-byte folder marker itself — callers must not mistake the marker for
 *   a child object.
 * - COPY requires its source in URL-encoded form (per the CopyObject API):
 *   a CopySource whose key portion carries a raw space, `#`, or `?` is
 *   refused exactly like the service refuses it, so a rename that forgets to
 *   encode fails here instead of silently passing.
 * - LIST pages at 1,000 keys with IsTruncated/NextContinuationToken, so a
 *   caller that never follows the token loses keys here exactly as against
 *   AWS. The token is the numeric offset of the next page.
 */

interface StoredObject {
  bytes: Buffer;
  lastModified: Date;
}

export interface FakeS3 {
  objects: Map<string, StoredObject>;
  sent: unknown[];
  client: S3Client;
}

/**
 * Failure injection for DeleteObjectsCommand: keys in `refuseDeleteKeys`
 * are answered with per-key errors (and left stored) exactly like the
 * service answers AccessDenied — the batch itself still returns 200.
 */
export interface FakeS3Options {
  refuseDeleteKeys?: Set<string>;
}

/** The middleware-stack input of an SDK command (what the backend constructed). */
export function commandInput(command: unknown): Record<string, unknown> {
  return (command as unknown as { input: Record<string, unknown> }).input;
}

function toBytes(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new Error("fake S3 only stores Buffer/string/Uint8Array bodies");
}

function noSuchKey(key: string): Error {
  const error = new Error(`NoSuchKey: ${key}`);
  error.name = "NoSuchKey";
  return error;
}

export function createFakeS3(options?: FakeS3Options): FakeS3 {
  const objects = new Map<string, StoredObject>();
  const sent: unknown[] = [];

  const send = async (command: unknown): Promise<unknown> => {
    sent.push(command);
    if (command instanceof PutObjectCommand) {
      const input = commandInput(command);
      objects.set(input["Key"] as string, { bytes: toBytes(input["Body"]), lastModified: new Date() });
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const stored = objects.get(commandInput(command)["Key"] as string);
      if (!stored) throw noSuchKey(commandInput(command)["Key"] as string);
      const bytes = stored.bytes;
      return { Body: { transformToByteArray: async () => bytes } };
    }
    if (command instanceof HeadObjectCommand) {
      const stored = objects.get(commandInput(command)["Key"] as string);
      if (!stored) throw noSuchKey(commandInput(command)["Key"] as string);
      return { ContentLength: stored.bytes.length, LastModified: stored.lastModified };
    }
    if (command instanceof DeleteObjectCommand) {
      objects.delete(commandInput(command)["Key"] as string);
      return {};
    }
    if (command instanceof DeleteObjectsCommand) {
      // Multi-object delete answers per key: refused keys come back in
      // Errors (the batch still returns 200), deleted keys in Deleted —
      // unless the caller passed Quiet, which suppresses Deleted only.
      const input = commandInput(command);
      const keys = ((input["Delete"] as { Objects?: { Key?: string }[] } | undefined)?.Objects ?? [])
        .map((entry) => entry.Key)
        .filter((key): key is string => typeof key === "string");
      const deleted: { Key: string }[] = [];
      const errors: { Key: string; Code: string; Message: string }[] = [];
      for (const key of keys) {
        if (options?.refuseDeleteKeys?.has(key)) {
          errors.push({ Key: key, Code: "AccessDenied", Message: "refused by fake S3" });
        } else {
          objects.delete(key);
          deleted.push({ Key: key });
        }
      }
      return input["Quiet"] ? { Errors: errors } : { Deleted: deleted, Errors: errors };
    }
    if (command instanceof ListObjectsV2Command) {
      const input = commandInput(command);
      const prefix = (input["Prefix"] as string | undefined) ?? "";
      const delimiter = input["Delimiter"] as string | undefined;
      const maxKeys = input["MaxKeys"] as number | undefined;
      const matching = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      // The service pages every listing at 1,000 keys: emulate pages over the
      // matched keyspace so callers that ignore the continuation token lose
      // keys here exactly as they would against AWS. The token is the numeric
      // offset of the next page; small listings still answer in one page.
      const rawToken = input["ContinuationToken"];
      const parsedToken = typeof rawToken === "string" ? Number(rawToken) : 0;
      const start = Number.isSafeInteger(parsedToken) && parsedToken >= 0 ? parsedToken : 0;
      const pageSize = maxKeys ?? 1000;
      const pageKeys = matching.slice(start, start + pageSize);
      const truncated = start + pageSize < matching.length;
      const continuation = {
        IsTruncated: truncated,
        NextContinuationToken: truncated ? String(start + pageSize) : undefined,
      };
      if (delimiter === undefined) {
        const contents = pageKeys.map((key) => ({
          Key: key,
          Size: objects.get(key)!.bytes.length,
          LastModified: objects.get(key)!.lastModified,
        }));
        return { Contents: contents, KeyCount: contents.length, ...continuation };
      }
      const prefixes = new Set<string>();
      const contents: { Key: string; Size: number; LastModified: Date }[] = [];
      for (const key of pageKeys) {
        const rest = key.slice(prefix.length);
        if (rest === "") {
          // The folder marker itself: listed as an object, never as a child.
          contents.push({ Key: key, Size: 0, LastModified: objects.get(key)!.lastModified });
        } else if (rest.includes(delimiter)) {
          prefixes.add(prefix + rest.split(delimiter)[0]! + delimiter);
        } else {
          contents.push({ Key: key, Size: objects.get(key)!.bytes.length, LastModified: objects.get(key)!.lastModified });
        }
      }
      return {
        CommonPrefixes: [...prefixes].sort().map((entry) => ({ Prefix: entry })),
        Contents: contents,
        KeyCount: contents.length,
        ...continuation,
      };
    }
    if (command instanceof CopyObjectCommand) {
      const input = commandInput(command);
      const copySource = input["CopySource"] as string;
      const slash = copySource.indexOf("/");
      const encodedKey = slash < 0 ? copySource : copySource.slice(slash + 1);
      // The service requires the encoded form: refuse a source that was
      // passed through raw, so an unencoded rename fails in tests exactly as
      // it fails against AWS (left behind, re-scanned as a duplicate).
      if (/[ #?]/.test(encodedKey)) {
        throw new Error(`InvalidRequest: x-amz-copy-source must be URL-encoded (got '${copySource}')`);
      }
      const sourceKey = encodedKey
        .split("/")
        .map((segment) => decodeURIComponent(segment))
        .join("/");
      const stored = objects.get(sourceKey);
      if (!stored) throw noSuchKey(sourceKey);
      objects.set(input["Key"] as string, { bytes: Buffer.from(stored.bytes), lastModified: new Date() });
      return {};
    }
    throw new Error(`fake S3 does not implement ${(command as { constructor: { name: string } }).constructor.name}`);
  };

  return { objects, sent, client: { send } as unknown as S3Client };
}

/** Every CopyObjectCommand the fake has seen, in send order. */
export function sentCopies(fake: FakeS3): { CopySource: string; Key: string }[] {
  return fake.sent
    .filter((command): command is CopyObjectCommand => command instanceof CopyObjectCommand)
    .map((command) => {
      const input = commandInput(command);
      return { CopySource: input["CopySource"] as string, Key: input["Key"] as string };
    });
}

/** Every DeleteObjectsCommand the fake has seen, in send order. */
export function sentDeletes(fake: FakeS3): string[][] {
  return fake.sent
    .filter((command): command is DeleteObjectsCommand => command instanceof DeleteObjectsCommand)
    .map((command) => {
      const input = commandInput(command);
      const objects = (input["Delete"] as { Objects?: { Key?: string }[] } | undefined)?.Objects ?? [];
      return objects
        .map((entry) => entry.Key)
        .filter((key): key is string => typeof key === "string");
    });
}
