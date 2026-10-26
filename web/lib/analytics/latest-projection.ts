import "server-only";
import {
  claimSharedCache,
  publishSharedCache,
  readSharedCache,
  releaseSharedCache,
} from "@openbooks/jobs/read-cache";
import { ANALYTICS_PREVIEW_FRESHNESS_MS } from "./preview-invalidation";

/**
 * The latest projection of an expensive read, kept for a day and answered at
 * once while a newer one is built.
 *
 * Within the freshness window, and while no write has advanced the
 * organization's analytics revision, a stored projection is current.
 * Otherwise it is still answered at once, marked `refreshing` with the time
 * it was calculated, and the caller arranges one rebuild. A missing or
 * expired projection is built before answering. Keys carry the caller's
 * authority, so a projection is never read by someone it was not built for;
 * the revision is stored with the value rather than keyed, so a write leaves
 * the previous projection available while the next one builds.
 */
const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_LOCAL = 256;
/** A projection larger than this is answered but not kept: it is cheaper to
 * rebuild than to hold. The process keeps at most the byte budget. */
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const MAX_LOCAL_BYTES = 96 * 1024 * 1024;

export type LatestProjection<T> = { data: T; observedAt: string; refreshing: boolean };

type Stored = { version: 1; revision: string; observedAt: string; payload: string };

const local = new Map<string, Stored>();
const building = new Map<string, Promise<{ data: unknown; observedAt: string }>>();
let localBytes = 0;

function forget(key: string) {
  const previous = local.get(key);
  if (previous) localBytes -= previous.payload.length;
  local.delete(key);
}

function remember(key: string, value: Stored) {
  forget(key);
  if (value.payload.length > MAX_PAYLOAD_BYTES) return;
  while (local.size >= MAX_LOCAL || localBytes + value.payload.length > MAX_LOCAL_BYTES) forget(local.keys().next().value!);
  local.set(key, value);
  localBytes += value.payload.length;
}

function decodeStored(raw: string | null | undefined): Stored | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Stored;
    return value.version === 1 &&
      typeof value.revision === "string" &&
      typeof value.observedAt === "string" &&
      typeof value.payload === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}

const ageOf = (value: Stored) => Date.now() - Date.parse(value.observedAt);
const retained = (value: Stored | null): value is Stored =>
  !!value && ageOf(value) >= 0 && ageOf(value) < RETENTION_MS;

/**
 * Projection payloads round-trip through JSON with their dates intact:
 * figures read from the database carry timestamps, and a revived projection
 * must render exactly as the one first built. A value JSON cannot carry
 * faithfully (a Map, a Set, a bigint, an undefined array slot) makes the
 * projection unkeepable: `null`, and the caller answers it without keeping it.
 */
export function encodeProjection(data: unknown): string | null {
  let faithful = true;
  const payload = JSON.stringify(data, function (this: Record<string, unknown>, key, value) {
    const original = this[key];
    if (original instanceof Date) return { $date: original.toISOString() };
    if (original instanceof Map || original instanceof Set || typeof original === "bigint") faithful = false;
    if (Array.isArray(original) && original.some((item) => item === undefined || typeof item === "function")) faithful = false;
    return typeof value === "bigint" ? null : value;
  });
  return faithful ? payload : null;
}

export function decodeProjection<T>(payload: string): T {
  return JSON.parse(payload, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && typeof value.$date === "string"
      ? new Date(value.$date)
      : value,
  ) as T;
}

/** Build the projection now and store it as the latest. Concurrent requests
 * for one key share the build. */
export function rebuildProjection<T>(
  key: string,
  revision: string,
  build: () => Promise<T>,
  observedAt: (data: T) => string = () => new Date().toISOString(),
): Promise<LatestProjection<T>> {
  let work = building.get(key) as Promise<{ data: T; observedAt: string }> | undefined;
  if (!work) {
    work = (async () => {
      const token = await claimSharedCache(key);
      try {
        const data = await build();
        const at = observedAt(data);
        const payload = encodeProjection(data);
        if (payload !== null) {
          const value: Stored = { version: 1, revision, observedAt: at, payload };
          remember(key, value);
          if (token && payload.length <= MAX_PAYLOAD_BYTES) await publishSharedCache(key, token, JSON.stringify(value), RETENTION_MS);
          return { data: decodeProjection<T>(payload), observedAt: at };
        }
        return { data, observedAt: at };
      } finally {
        if (token) await releaseSharedCache(key, token);
      }
    })().finally(() => building.delete(key));
    building.set(key, work);
  }
  // Each caller receives its own copy: callers annotate what they answer.
  return work.then((value) => ({ data: structuredClone(value.data), observedAt: value.observedAt, refreshing: false }));
}

/**
 * The latest projection for a key: current, or the last one marked
 * refreshing, or (when none is retained) a fresh build. A refreshing answer
 * leaves the rebuild to the caller.
 */
export async function latestProjection<T>(
  key: string,
  revision: string,
  build: () => Promise<T>,
  observedAt?: (data: T) => string,
): Promise<LatestProjection<T>> {
  const known = local.get(key) ?? null;
  const stored = retained(known) ? known : decodeStored(await readSharedCache(key));
  if (!retained(stored)) return rebuildProjection(key, revision, build, observedAt);
  remember(key, stored);
  const current = stored.revision === revision && ageOf(stored) < ANALYTICS_PREVIEW_FRESHNESS_MS;
  return { data: decodeProjection<T>(stored.payload), observedAt: stored.observedAt, refreshing: !current };
}
