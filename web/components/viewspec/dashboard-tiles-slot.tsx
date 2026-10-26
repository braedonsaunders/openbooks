import "server-only";

import type { CSSProperties } from "react";
import { getAuthz } from "../../lib/authz";
import { WIDGETS } from "../../app/(app)/dashboard/_widget-registry";
import { resolveAllowedWidgetIds } from "../../app/(app)/dashboard/widget-features";
import { loadDashboardView } from "../../app/(app)/dashboard/_edit-canvas";

/** The home dashboard's grid metrics, so an embedded tile is the same size it is at home. */
const ROW_HEIGHT = 48;
const GAP = 16;
const MAX_TILES = 24;

export type DashboardTileRequest = { id: string; w?: number; h?: number };

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  const chosen = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(Math.max(chosen, min), max);
}

/**
 * Selected home-dashboard tiles placed on any page or app screen.
 *
 * A spec names catalog ids and sizes only; the tiles' data, permission checks
 * and feature gates are re-derived here from the reader's own session through
 * the same resolver and canvas loader the home dashboard uses. A tile the
 * reader may not see is omitted entirely — its absence discloses nothing, and
 * no figure is rendered from a reader the viewer could not run themselves.
 */
export async function DashboardTilesSlot({
  widgets,
}: {
  widgets: readonly DashboardTileRequest[];
}) {
  const authz = await getAuthz();
  if (!authz) return null;
  const allowed = await resolveAllowedWidgetIds(authz);
  const seen = new Set<string>();
  const placed = widgets
    .flatMap((request) => {
      const meta = WIDGETS[request.id];
      if (!meta || seen.has(request.id) || !allowed.has(request.id)) return [];
      seen.add(request.id);
      const w = clamp(request.w, meta.defaultSize.w, meta.minSize.w, meta.maxSize?.w ?? 12);
      const h = clamp(request.h, meta.defaultSize.h, meta.minSize.h, meta.maxSize?.h ?? 12);
      return [{ id: request.id, x: 0, y: 0, w, h }];
    })
    .slice(0, MAX_TILES);
  if (placed.length === 0) return null;

  const { nodes } = await loadDashboardView(authz, { widgets: placed }, allowed);
  return (
    <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-6 lg:grid-cols-12">
      {placed
        .filter((tile) => nodes[tile.id] !== undefined)
        .map((tile) => (
          <div
            key={tile.id}
            className="min-w-0 sm:[grid-column:span_min(var(--tile-span),6)/span_min(var(--tile-span),6)] lg:[grid-column:span_var(--tile-span)/span_var(--tile-span)]"
            style={
              {
                "--tile-span": tile.w,
                height: tile.h * ROW_HEIGHT + (tile.h - 1) * GAP,
              } as CSSProperties
            }
          >
            {nodes[tile.id]}
          </div>
        ))}
    </div>
  );
}
