"use client";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Select, Badge, Input } from "@openbooks/ui";
import * as maplibregl from "maplibre-gl";
import { type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  TerraDraw,
  TerraDrawPolygonMode,
  TerraDrawFreehandMode,
  TerraDrawSelectMode,
} from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import type {
  AreaGeometry,
  BoundarySelection,
  SalesRecord,
  TerritoryGeography,
} from "@openbooks/engine/crm/sales/contracts";
import { EMPTY_TERRITORY_GEOGRAPHY } from "@openbooks/engine/crm/sales/contracts";
import { apiJson } from "@/lib/api-error";

export function TerritoryMap({
  value = EMPTY_TERRITORY_GEOGRAPHY,
  onChange,
  territories = [],
  onTerritoryClick,
}: {
  value?: TerritoryGeography;
  onChange?: (v: TerritoryGeography) => void;
  territories?: SalesRecord[];
  onTerritoryClick?: (id: string) => void;
}) {
  const t = useTranslations("crm.sales");
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const draw = useRef<TerraDraw | null>(null);
  const state = useRef({
    value,
    onChange,
    onTerritoryClick,
    boundaries: [] as BoundarySelection[],
    excluded: false,
    mode: "select",
  });

  const [countries, setCountries] = useState<{ id: string; name: string }[]>(
    [],
  );
  const [country, setCountry] = useState("CAN");
  const [level, setLevel] = useState<"ADM0" | "ADM1" | "ADM2">("ADM1");
  const [boundaries, setBoundaries] = useState<BoundarySelection[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [excluded, setExcluded] = useState(false);
  const [mode, setMode] = useState("select");
  const [search, setSearch] = useState("");
  useEffect(() => {
    state.current = {
      value,
      onChange,
      onTerritoryClick,
      boundaries,
      excluded,
      mode,
    };
  }, [value, onChange, onTerritoryClick, boundaries, excluded, mode]);
  useEffect(() => {
    let active = true;
    apiJson<{ id: string; name: string }[]>(
      "/api/crm/sales/boundaries?countries=true",
      undefined,
      t("mapFailed"),
    )
      .then((v) => {
        if (active) setCountries(v);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [t]);
  useEffect(() => {
    if (!container.current) return;
    let stopped = false;
    const instance = new maplibregl.Map({
      container: container.current,
      style: {
        version: 8,
        sources: {},
        layers: [
          {
            id: "background",
            type: "background",
            paint: { "background-color": "#edf3f7" },
          },
        ],
      },
      center: [-96, 52],
      zoom: 2,
      attributionControl: { compact: true },
    });
    map.current = instance;
    instance.addControl(new maplibregl.NavigationControl(), "top-right");
    instance.addControl(
      new maplibregl.AttributionControl({
        customAttribution:
          '<a href="https://www.geoboundaries.org" target="_blank" rel="noopener noreferrer">geoBoundaries · CC BY 4.0</a>',
      }),
      "bottom-right",
    );
    instance.on("error", () => {
      if (!stopped) setError(t("mapFailed"));
    });
    instance.on("load", () => {
      for (const source of ["boundaries", "coverage"])
        instance.addSource(source, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      instance.addLayer({
        id: "boundaries-fill",
        type: "fill",
        source: "boundaries",
        paint: { "fill-color": "#d9e4ec", "fill-opacity": 0.8 },
      });
      instance.addLayer({
        id: "boundaries-line",
        type: "line",
        source: "boundaries",
        paint: { "line-color": "#7f94a5", "line-width": 1 },
      });
      instance.addLayer({
        id: "coverage-fill",
        type: "fill",
        source: "coverage",
        paint: {
          "fill-color": ["case", ["get", "excluded"], "#dc735f", "#0d9488"],
          "fill-opacity": 0.28,
        },
      });
      instance.addLayer({
        id: "coverage-line",
        type: "line",
        source: "coverage",
        paint: {
          "line-color": ["case", ["get", "excluded"], "#dc735f", "#0d9488"],
          "line-width": 2,
        },
      });
      instance.on("click", "boundaries-fill", (e) => {
        const current = state.current;
        if (!current.onChange || current.mode !== "select") return;
        const id = e.features?.[0]?.properties?.id;
        const boundary = current.boundaries.find((b) => b.id === id);
        if (!boundary) return;
        const key = current.excluded ? "excludes" : "includes";
        const list = current.value[key];
        const exists = list.some(
          (b) =>
            b.id === boundary.id &&
            b.country === boundary.country &&
            b.level === boundary.level,
        );
        current.onChange({
          ...current.value,
          [key]: exists
            ? list.filter(
                (b) =>
                  !(
                    b.id === boundary.id &&
                    b.country === boundary.country &&
                    b.level === boundary.level
                  ),
              )
            : [...list, boundary],
        });
      });
      instance.on("click", "coverage-fill", (e) => {
        if (!state.current.onChange) {
          const id = e.features?.[0]?.properties?.territoryId;
          if (id) state.current.onTerritoryClick?.(id);
        }
      });
      if (state.current.onChange) {
        const drawing = new TerraDraw({
          adapter: new TerraDrawMapLibreGLAdapter({
            map: instance,
            coordinatePrecision: 7,
          }),
          modes: [
            new TerraDrawPolygonMode(),
            new TerraDrawFreehandMode(),
            new TerraDrawSelectMode({
              flags: {
                polygon: {
                  feature: {
                    draggable: true,
                    coordinates: {
                      draggable: true,
                      midpoints: true,
                      deletable: true,
                    },
                  },
                },
                freehand: {
                  feature: {
                    draggable: true,
                    coordinates: { draggable: true },
                  },
                },
              },
            }),
          ],
        });
        draw.current = drawing;
        drawing.start();
        drawing.setMode("select");
        drawing.addFeatures(
          state.current.value.polygons.flatMap((p) =>
            p.geometry.type === "Polygon"
              ? [
                  {
                    type: "Feature" as const,
                    id: p.id,
                    geometry: p.geometry,
                    properties: { mode: "polygon" },
                  },
                ]
              : [],
          ),
        );
        drawing.on("finish", () => {
          const current = state.current;
          current.onChange?.({
            ...current.value,
            polygons: drawing
              .getSnapshot()
              .filter(
                (f) =>
                  f.geometry.type === "Polygon" &&
                  f.properties.mode !== "select",
              )
              .map((f, i) => ({
                id: String(f.id),
                name: `${t("drawnArea")} ${i + 1}`,
                geometry: f.geometry as AreaGeometry,
              })),
          });
        });
        drawing.on("change", () => {
          const current = state.current;
          if (current.mode !== "select") return;
          current.onChange?.({
            ...current.value,
            polygons: drawing
              .getSnapshot()
              .filter((f) => f.geometry.type === "Polygon")
              .map((f, i) => ({
                id: String(f.id),
                name:
                  current.value.polygons.find((p) => p.id === String(f.id))
                    ?.name ?? `${t("drawnArea")} ${i + 1}`,
                geometry: f.geometry as AreaGeometry,
              })),
          });
        });
      }
      if (!stopped) setReady(true);
    });
    return () => {
      stopped = true;
      draw.current?.stop();
      draw.current = null;
      instance.remove();
      map.current = null;
    };
  }, [t]);
  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => {
      if (active) {
        setLoading(true);
        setError("");
      }
    });
    apiJson<BoundarySelection[]>(
      `/api/crm/sales/boundaries?country=${country}&level=${level}`,
      undefined,
      t("mapFailed"),
    )
      .then((v) => {
        if (active) setBoundaries(v);
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
          setBoundaries([]);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [country, level, t]);
  useEffect(() => {
    if (!ready || !map.current) return;
    const instance = map.current;
    (instance.getSource("boundaries") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: boundaries.map((b) => ({
        type: "Feature",
        geometry: b.geometry,
        properties: { id: b.id, name: b.name },
      })),
    });
    if (boundaries.length) {
      const bounds = new maplibregl.LngLatBounds();
      for (const b of boundaries) {
        const polygons =
          b.geometry.type === "Polygon"
            ? [b.geometry.coordinates]
            : b.geometry.coordinates;
        for (const rings of polygons)
          for (const ring of rings) for (const pos of ring) bounds.extend(pos);
      }
      if (!bounds.isEmpty())
        instance.fitBounds(bounds, { padding: 40, maxZoom: 8, duration: 500 });
    }
  }, [ready, boundaries]);
  useEffect(() => {
    if (!ready || !map.current) return;
    const entries = onChange
      ? [{ id: "editing", geography: value }]
      : territories.map((r) => ({
          id: r.id,
          geography: r.geography ?? EMPTY_TERRITORY_GEOGRAPHY,
        }));
    const features: GeoJSON.Feature<AreaGeometry>[] = [];
    for (const entry of entries) {
      for (const b of [
        ...entry.geography.includes,
        ...entry.geography.excludes,
      ])
        features.push({
          type: "Feature",
          geometry: b.geometry,
          properties: {
            territoryId: entry.id,
            excluded: entry.geography.excludes.includes(b),
          },
        });
      for (const p of entry.geography.polygons)
        features.push({
          type: "Feature",
          geometry: p.geometry,
          properties: { territoryId: entry.id, excluded: false },
        });
    }
    (map.current.getSource("coverage") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features,
    });
  }, [ready, onChange, value, territories]);
  function drawingMode(next: string) {
    setMode(next);
    state.current.mode = next;
    draw.current?.setMode(next);
  }
  function toggle(boundary: BoundarySelection) {
    const key = excluded ? "excludes" : "includes";
    const present = value[key].some(
      (b) =>
        b.id === boundary.id &&
        b.country === boundary.country &&
        b.level === boundary.level,
    );
    onChange?.({
      ...value,
      [key]: present
        ? value[key].filter(
            (b) =>
              !(
                b.id === boundary.id &&
                b.country === boundary.country &&
                b.level === boundary.level
              ),
          )
        : [...value[key], boundary],
    });
  }
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">
      <div className="flex flex-wrap items-center gap-2 bg-white p-3 dark:bg-slate-900">
        <Select
          aria-label={t("country")}
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          className="max-w-xs"
        >
          {countries.length ? (
            countries.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))
          ) : (
            <option value="CAN">Canada</option>
          )}
        </Select>
        <Select
          aria-label={t("boundaryLevel")}
          value={level}
          onChange={(e) => setLevel(e.target.value as typeof level)}
        >
          <option value="ADM0">{t("countries")}</option>
          <option value="ADM1">{t("statesProvinces")}</option>
          <option value="ADM2">{t("countiesDistricts")}</option>
        </Select>
        {onChange ? (
          <>
            <Select
              aria-label={t("selectionMode")}
              value={excluded ? "exclude" : "include"}
              onChange={(e) => setExcluded(e.target.value === "exclude")}
            >
              <option value="include">{t("include")}</option>
              <option value="exclude">{t("exclude")}</option>
            </Select>
            {["select", "polygon", "freehand"].map((v) => (
              <Button
                key={v}
                variant={mode === v ? "secondary" : "outline"}
                onClick={() => drawingMode(v)}
              >
                {t(v)}
              </Button>
            ))}
          </>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="bg-amber-50 p-3 text-sm text-amber-900">
          {error}
        </p>
      ) : null}
      <div
        ref={container}
        className="h-[440px] w-full"
        aria-label={t("map")}
        aria-busy={loading}
      />
      {onChange ? (
        <div className="space-y-3 border-t bg-white p-3 dark:bg-slate-900">
          <p className="text-xs text-slate-500">{t("mapHelp")}</p>
          <Input
            aria-label={t("searchAreas")}
            placeholder={t("searchAreas")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
            {boundaries
              .filter((b) =>
                b.name.toLowerCase().includes(search.toLowerCase()),
              )
              .map((b) => (
                <Button
                  key={b.id}
                  variant={
                    value[excluded ? "excludes" : "includes"].some(
                      (v) =>
                        v.id === b.id &&
                        v.country === b.country &&
                        v.level === b.level,
                    )
                      ? "secondary"
                      : "outline"
                  }
                  onClick={() => toggle(b)}
                >
                  {b.name}
                </Button>
              ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {(["includes", "excludes"] as const).flatMap((key) =>
              value[key].map((b) => (
                <Badge key={key + b.country + b.level + b.id}>
                  {key === "excludes" ? "−" : "+"} {b.name}{" "}
                  <button
                    type="button"
                    aria-label={`${t("remove")} ${b.name}`}
                    onClick={() =>
                      onChange({
                        ...value,
                        [key]: value[key].filter((v) => v !== b),
                      })
                    }
                  >
                    ×
                  </button>
                </Badge>
              )),
            )}
            {value.polygons.map((p) => (
              <Badge key={p.id}>
                {p.name}{" "}
                <button
                  type="button"
                  aria-label={`${t("remove")} ${p.name}`}
                  onClick={() => {
                    draw.current?.removeFeatures([p.id]);
                    onChange({
                      ...value,
                      polygons: value.polygons.filter((v) => v.id !== p.id),
                    });
                  }}
                >
                  ×
                </button>
              </Badge>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
