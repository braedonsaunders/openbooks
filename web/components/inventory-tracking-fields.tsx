"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Label, SearchSelect } from "@openbooks/ui";
import { readApiErrorMessage } from "@/lib/api-error";
import { promptDialog } from "@/lib/prompt";
interface Option {
  id: string;
  label: string;
  expiry?: string | null;
  lot_id?: string | null;
  hold_reason?: string | null;
}
export function InventoryTrackingFields({
  itemId,
  lotId,
  serialId,
  onChange,
  disabled = false,
  canCreate = false,
}: {
  itemId: string;
  lotId: string;
  serialId: string;
  onChange: (lot: string, serial: string) => void;
  disabled?: boolean;
  canCreate?: boolean;
}) {
  const t = useTranslations("inventory.controls");
  const [search, setSearch] = useState(""),
    [revision, setRevision] = useState(0),
    [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<{
    tracking: string;
    lots: Option[];
    serials: Option[];
  } | null>(null);
  useEffect(() => {
    if (!itemId) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ itemId, q: search });
      if (lotId) query.set("lotId", lotId);
      void fetch(`/api/inventory/tracking-options?${query}`, {
        signal: abort.signal,
      })
        .then(async (response) => {
          if (!response.ok)
            throw new Error(
              await readApiErrorMessage(response, t("loadFailed")),
            );
          const result = await response.json();
          if (abort.signal.aborted) return;
          setData(result);
          setError(null);
        })
        .catch((e) => {
          if (!abort.signal.aborted)
            setError(e instanceof Error ? e.message : t("loadFailed"));
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [itemId, lotId, search, revision, t]);
  async function create(kind: "lot" | "serial") {
    const number = await promptDialog({
      title: kind === "lot" ? t("newLot") : t("newSerial"),
      label: t("identifier"),
    });
    if (!number) return;
    const expiry =
      kind === "lot"
        ? await promptDialog({
            title: t("expiry"),
            message: t("expiryOptional"),
            placeholder: "YYYY-MM-DD",
          })
        : null;
    try {
      const response = await fetch("/api/inventory/advanced", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          kind === "lot"
            ? {
                action: "ensureLot",
                itemId,
                lotNumber: number,
                expiresOn: expiry?.trim() || null,
              }
            : { action: "ensureSerial", itemId, serialNumber: number },
        ),
      });
      if (!response.ok)
        throw new Error(await readApiErrorMessage(response, t("saveFailed")));
      const saved = await response.json();
      onChange(
        kind === "lot" ? saved.id : lotId,
        kind === "serial" ? saved.id : "",
      );
      setSearch("");
      setRevision((r) => r + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("saveFailed"));
    }
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {error ? (
        <p role="alert" className="text-sm text-red-600 sm:col-span-2">
          {error}
        </p>
      ) : null}
      {data?.tracking === "lot" || data?.tracking === "lot_serial" ? (
        <div>
          <Label>{t("lot")}</Label>
          <SearchSelect
            value={lotId}
            onChange={(v) => onChange(v, "")}
            options={data.lots.map((o) => ({
              value: o.id,
              label: [o.label, o.expiry, o.hold_reason ? t("held") : null]
                .filter(Boolean)
                .join(" · "),
            }))}
            remote
            onSearchChange={setSearch}
            disabled={disabled}
            ariaLabel={t("lot")}
          />
          {canCreate ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => void create("lot")}
            >
              {t("newLot")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {data?.tracking === "serial" || data?.tracking === "lot_serial" ? (
        <div>
          <Label>{t("serial")}</Label>
          <SearchSelect
            value={serialId}
            onChange={(v) =>
              onChange(data.serials.find((o) => o.id === v)?.lot_id ?? lotId, v)
            }
            options={data.serials.map((o) => ({ value: o.id, label: o.label }))}
            remote
            onSearchChange={setSearch}
            disabled={disabled}
            ariaLabel={t("serial")}
          />
          {canCreate ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => void create("serial")}
            >
              {t("newSerial")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
