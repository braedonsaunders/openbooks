import "server-only";
import { createHash } from "node:crypto";
import { SalesError } from "@openbooks/engine/crm/sales";
import type {
  AreaGeometry,
  BoundarySelection,
  TerritoryGeography,
} from "@openbooks/engine/crm/sales/contracts";

type Metadata = {
  boundaryISO: string;
  boundaryName: string;
  boundaryID: string;
  simplifiedGeometryGeoJSON: string;
};
const cache = new Map<
  string,
  { expires: number; value: BoundarySelection[] }
>();
/** Only the publisher's fixed public endpoints are fetched. Customer addresses
 * and employee information never leave the application. */
async function publisherJson(url: string, hops = 0): Promise<unknown> {
  if (hops > 4)
    throw new SalesError(
      "The boundary publisher redirected too many times. Retry the download.",
      502,
    );
  const parsed = new URL(url);
  const allowed =
    parsed.protocol === "https:" &&
    ((parsed.hostname === "www.geoboundaries.org" &&
      parsed.pathname.startsWith("/api/current/gbOpen/")) ||
      ([
        "github.com",
        "raw.githubusercontent.com",
        "media.githubusercontent.com",
      ].includes(parsed.hostname) &&
        /^\/(?:media\/)?wmgeolab\/geoBoundaries\//.test(parsed.pathname)));
  if (!allowed)
    throw new SalesError(
      "The boundary publisher returned an unsupported download location.",
      502,
    );
  const res = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
    cache: "no-store",
  });
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const location = res.headers.get("location");
    if (!location)
      throw new SalesError(
        "The boundary download did not provide a destination.",
        502,
      );
    return publisherJson(new URL(location, url).href, hops + 1);
  }
  if (!res.ok)
    throw new SalesError(
      "This administrative boundary is unavailable. Choose another level or draw a territory.",
      422,
    );
  const reader = res.body?.getReader();
  if (!reader)
    throw new SalesError(
      "The boundary publisher returned an empty download.",
      502,
    );
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 32 * 1024 * 1024)
        throw new SalesError(
          "This boundary is too large. Choose smaller areas or draw a territory.",
          422,
        );
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = Buffer.concat(chunks);
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new SalesError(
      "The boundary publisher returned unreadable data. Retry the download.",
      502,
    );
  }
}
export async function salesCountries(): Promise<
  { id: string; name: string }[]
> {
  const data = (await publisherJson(
    "https://www.geoboundaries.org/api/current/gbOpen/ALL/ADM0/",
  )) as Metadata[];
  if (!Array.isArray(data))
    throw new SalesError(
      "Country boundaries are temporarily unavailable. Retry or draw an area.",
      502,
    );
  return data
    .filter((m) => /^[A-Z]{3}$/.test(m.boundaryISO))
    .map((m) => ({ id: m.boundaryISO, name: m.boundaryName }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
export async function salesBoundaries(
  country: string,
  level: "ADM0" | "ADM1" | "ADM2",
): Promise<BoundarySelection[]> {
  if (!/^[A-Z]{3}$/.test(country) || !["ADM0", "ADM1", "ADM2"].includes(level))
    throw new SalesError("Choose a valid country and boundary level.");
  const key = country + level;
  const existing = cache.get(key);
  if (existing && existing.expires > Date.now()) return existing.value;
  const metadata = (await publisherJson(
    `https://www.geoboundaries.org/api/current/gbOpen/${country}/${level}/`,
  )) as Metadata;
  if (!metadata?.simplifiedGeometryGeoJSON || !metadata.boundaryID)
    throw new SalesError(
      "This boundary level is unavailable. Select another level or draw an area.",
    );
  const data = (await publisherJson(metadata.simplifiedGeometryGeoJSON)) as {
    type: string;
    features: {
      properties: { shapeID: string; shapeName: string };
      geometry: AreaGeometry;
    }[];
  };
  if (data.type !== "FeatureCollection" || !Array.isArray(data.features))
    throw new SalesError(
      "The boundary publisher returned an invalid map.",
      502,
    );
  const version =
    metadata.boundaryID +
    ":" +
    createHash("sha256")
      .update(JSON.stringify(data))
      .digest("hex")
      .slice(0, 16);
  const value = data.features
    .filter(
      (f) =>
        f.geometry?.type === "Polygon" || f.geometry?.type === "MultiPolygon",
    )
    .map((f) => ({
      country,
      level,
      id: String(f.properties.shapeID),
      name: String(f.properties.shapeName || metadata.boundaryName),
      version,
      geometry: f.geometry,
    }));
  if (cache.size >= 24) cache.delete(cache.keys().next().value!);
  cache.set(key, { expires: Date.now() + 3600000, value });
  return value;
}
export async function canonicalizeSalesGeography(
  geo: TerritoryGeography,
): Promise<TerritoryGeography> {
  async function canonical(selections: BoundarySelection[]) {
    const result: BoundarySelection[] = [];
    const seen = new Set<string>();
    for (const selected of selections) {
      const key = selected.country + selected.level + selected.id;
      if (seen.has(key)) throw new SalesError("Select each boundary once.");
      seen.add(key);
      const boundary = (
        await salesBoundaries(selected.country, selected.level)
      ).find((b) => b.id === selected.id);
      if (!boundary || boundary.version !== selected.version)
        throw new SalesError(
          "The published boundary changed. Reload the map and select the area again.",
          409,
        );
      result.push(boundary);
    }
    return result;
  }
  return {
    version: 1,
    includes: await canonical(geo.includes),
    excludes: await canonical(geo.excludes),
    polygons: geo.polygons,
  };
}
