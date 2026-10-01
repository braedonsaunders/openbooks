import type {
  AreaGeometry,
  Position,
  TerritoryGeography,
} from "./sales-contracts.ts";

/** Administrative boundaries and drawn coverage use the same deterministic
 * point test. Exclusion edges win, including a point directly on the edge. */
function ringContains(point: Position, ring: Position[]): boolean {
  if (ring.length < 4) return false;
  const unwrap = (longitude: number, reference: number) =>
    reference + (((longitude - reference + 540) % 360) - 180);
  const points: Position[] = [];
  for (const p of ring)
    points.push([points.length ? unwrap(p[0], points.at(-1)![0]) : p[0], p[1]]);
  const min = points.reduce((v, p) => Math.min(v, p[0]), Infinity),
    max = points.reduce((v, p) => Math.max(v, p[0]), -Infinity);
  const x = unwrap(point[0], (min + max) / 2),
    y = point[1];
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j]!,
      b = points[i]!,
      ax = a[0],
      bx = b[0];
    const cross = (x - ax) * (b[1] - a[1]) - (y - a[1]) * (bx - ax);
    if (
      Math.abs(cross) < 1e-9 &&
      x >= Math.min(ax, bx) &&
      x <= Math.max(ax, bx) &&
      y >= Math.min(a[1], b[1]) &&
      y <= Math.max(a[1], b[1])
    )
      return true;
    if (
      a[1] > y !== b[1] > y &&
      x < ((bx - ax) * (y - a[1])) / (b[1] - a[1]) + ax
    )
      inside = !inside;
  }
  return inside;
}
export function geometryContains(
  geometry: AreaGeometry,
  point: Position,
): boolean {
  const polygons =
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some(
    (rings) =>
      rings.length > 0 &&
      ringContains(point, rings[0]!) &&
      !rings.slice(1).some((ring) => ringContains(point, ring)),
  );
}
export function hasGeographicCoverage(geography: TerritoryGeography): boolean {
  return geography.includes.length > 0 || geography.polygons.length > 0;
}
export function geographyMatches(
  geography: TerritoryGeography,
  point: Position | null,
): boolean {
  if (!hasGeographicCoverage(geography)) return geography.excludes.length === 0;
  if (!point) return false;
  return (
    (geography.includes.some((area) =>
      geometryContains(area.geometry, point),
    ) ||
      geography.polygons.some((area) =>
        geometryContains(area.geometry, point),
      )) &&
    !geography.excludes.some((area) => geometryContains(area.geometry, point))
  );
}
export function validateDrawnGeometry(geometry: AreaGeometry): string | null {
  const polygons =
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  if (polygons.length === 0 || polygons.length > 20)
    return "Draw between one and twenty areas.";
  for (const rings of polygons) {
    if (rings.length === 0) return "A drawn area needs an outer boundary.";
    for (const ring of rings) {
      if (ring.length < 4 || ring.length > 1001)
        return "A boundary needs three vertices and supports at most 1,000 vertices.";
      if (
        ring.some(
          (p) =>
            p.length !== 2 ||
            !Number.isFinite(p[0]) ||
            !Number.isFinite(p[1]) ||
            Math.abs(p[0]) > 180 ||
            Math.abs(p[1]) > 90,
        )
      )
        return "Use valid longitude and latitude coordinates.";
      if (ring[0]![0] !== ring.at(-1)![0] || ring[0]![1] !== ring.at(-1)![1])
        return "Close the drawn boundary before saving.";
      let twiceArea = 0;
      for (let i = 0; i < ring.length - 1; i++)
        twiceArea +=
          ring[i]![0] * ring[i + 1]![1] - ring[i + 1]![0] * ring[i]![1];
      if (Math.abs(twiceArea) < 1e-10)
        return "Draw an area with a nonzero extent.";
      const orientation = (a: Position, b: Position, c: Position) =>
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      for (let i = 0; i < ring.length - 1; i++)
        for (let j = i + 2; j < ring.length - 1; j++) {
          if (i === 0 && j === ring.length - 2) continue;
          const a = ring[i]!,
            b = ring[i + 1]!,
            c = ring[j]!,
            d = ring[j + 1]!;
          if (
            orientation(a, b, c) * orientation(a, b, d) < 0 &&
            orientation(c, d, a) * orientation(c, d, b) < 0
          )
            return "Remove the crossing edges from the drawn boundary.";
        }
    }
  }
  return null;
}
