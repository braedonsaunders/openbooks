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

export type LatestProjection<T> = { data: T; observedAt: string; refreshing: boolean };

type Stored = { version: 1; revision: string; observedAt: string; payload: string };

const local = new Map<string, Stored>();
const building = new Map<string, Promise<Stored>>();

function remember(key: string, value: Stored) {
  local.delete(key);
  if (local.size >= MAX_LOCAL) local.delete(local.keys().next().value!);
  local.set(key, value);
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
 * must render exactly as the one first built.
 */
export function encodeProjection(data: unknown): string {
  return JSON.stringify(data, function (this: Record<string, unknown>, key, value) {
    const original = this[key];
    return original instanceof Date ? { $date: original.toISOString() } : value;
  });
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
  let work = building.get(key);
  if (!work) {
    work = (async () => {
      const token = await claimSharedCache(key);
      try {
        const data = await build();
        const value: Stored = { version: 1, revision, observedAt: observedAt(data), payload: encodeProjection(data) };
        remember(key, value);
        if (token) await publishSharedCache(key, token, JSON.stringify(value), RETENTION_MS);
        return value;
      } finally {
        if (token) await releaseSharedCache(key, token);
      }
    })().finally(() => building.delete(key));
    building.set(key, work);
  }
  return work.then((value) => ({ data: decodeProjection<T>(value.payload), observedAt: value.observedAt, refreshing: false }));
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
