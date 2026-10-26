"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { FieldLabel, SearchSelect, Select, type SelectOption } from "@openbooks/ui";
import { FilterChips } from "@/components/filter-bar";
import { genealogyHref } from "./genealogy-url";

type Seed = SelectOption;

export function GenealogySeedPicker({
  kind,
  id,
  direction,
  maxDepth,
  initialSeeds,
}: {
  kind: "lot" | "serial";
  id?: string;
  direction: "forward" | "backward";
  maxDepth: number;
  initialSeeds: Seed[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useTranslations("manufacturing.genealogy");
  const m = useTranslations("manufacturing");
  const [query, setQuery] = useState("");
  const [seeds, setSeeds] = useState(initialSeeds);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setFailed(false);
      const params = new URLSearchParams({ kind, q: query });
      if (id) params.set("selected", id);
      try {
        const response = await fetch(`/api/manufacturing/genealogy/seeds?${params}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("genealogy_seed_search_failed");
        const rows = (await response.json()) as Seed[];
        setSeeds(rows);
      } catch {
        if (!controller.signal.aborted) {
          setFailed(true);
          setSeeds(initialSeeds);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [id, initialSeeds, kind, query]);

  const navigate = (update: Parameters<typeof genealogyHref>[1]) => {
    router.push(genealogyHref(searchParams.toString(), update) as never, { scroll: false });
  };
  const kindOptions = [
    { value: "lot", label: m("values.lot") },
    { value: "serial", label: m("values.serial") },
  ];
  const directionOptions = [
    { value: "forward", label: t("forward") },
    { value: "backward", label: t("backward") },
  ];

  return (
    <div className="flex flex-wrap items-end gap-3" role="group" aria-label={t("title")}>
      <div className="min-w-36 space-y-1">
        <FieldLabel htmlFor="genealogy-kind">
          {m("values.lot")}/{m("values.serial")}
        </FieldLabel>
        <Select
          id="genealogy-kind"
          aria-label={`${m("values.lot")}/${m("values.serial")}`}
          value={kind}
          onChange={(event) => {
            setQuery("");
            navigate({ kind: event.target.value === "serial" ? "serial" : "lot" });
          }}
        >
          {kindOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="min-w-64 flex-1 space-y-1">
        <FieldLabel htmlFor="genealogy-seed">{t("choose")}</FieldLabel>
        <SearchSelect
          id="genealogy-seed"
          value={id ?? ""}
          options={seeds}
          ariaLabel={t("choose")}
          placeholder={t("choose")}
          searchPlaceholder={m("searchPlaceholder")}
          emptyLabel={t("chooseNote")}
          remote
          loading={loading}
          statusMessage={failed ? m("loadFailed") : undefined}
          statusTone={failed ? "error" : "muted"}
          onSearchChange={setQuery}
          onChange={(value) => {
            if (value) navigate({ id: value });
          }}
        />
      </div>
      <FilterChips
        value={direction}
        onChange={(value) => navigate({ direction: value === "backward" ? "backward" : "forward" })}
        paramKey="direction"
        label={t("direction")}
        options={directionOptions}
        hideAll
      />
      <div className="min-w-28 space-y-1">
        <FieldLabel htmlFor="genealogy-depth">{t("depth")}</FieldLabel>
        <Select
          id="genealogy-depth"
          aria-label={t("depth")}
          value={String(maxDepth)}
          onChange={(event) => navigate({ maxDepth: Number(event.target.value) })}
        >
          {Array.from({ length: 32 }, (_, index) => index + 1).map((depth) => (
            <option key={depth} value={depth}>
              {depth}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}
