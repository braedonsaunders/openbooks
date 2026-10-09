"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Input, Label, SearchSelect, Select } from "@openbooks/ui";
import {
  RegisteredListTable,
  type RegisteredListColumn,
} from "@/components/registered-list-table";
import { AsyncUrlDrawer } from "@/components/async-url-drawer";
import { InventoryTrackingFields } from "@/components/inventory-tracking-fields";
import { useBusinessToday } from "@/components/business-date-provider";
import { useDirtyClose } from "@/lib/use-dirty-close";
import { promptDialog } from "@/lib/prompt";
import { readApiErrorMessage } from "@/lib/api-error";
import type { InventoryInquiry } from "@openbooks/engine/inventory/contracts";

type Row = Record<string, unknown>;
export interface StockControlPickers {
  items: { id: string; code: string | null; name: string | null }[];
  stockLocations: { id: string; code: string | null }[];
  subsidiaries: { id: string; name: string }[];
  accounts: { id: string; number: string | null; name: string | null }[];
}
const headings: Record<InventoryInquiry, string[]> = {
  holds: ["item", "entity", "kind", "identifier", "expiry", "reason"],
  consignment: [
    "item",
    "entity",
    "location",
    "ownership",
    "owner",
    "quantity",
    "lot",
    "serial",
    "date",
  ],
  cycle_due: [
    "item",
    "entity",
    "class",
    "interval",
    "tolerance",
    "last_count",
    "due_on",
    "status",
  ],
  layers: [
    "date",
    "entity",
    "location",
    "lot",
    "serial",
    "received",
    "remaining",
    "unit_cost",
    "value",
    "source_kind",
    "source_movement_id",
    "source_memo",
    "document",
    "journal_entry_id",
  ],
  consumptions: [
    "date",
    "entity",
    "kind",
    "movement_id",
    "quantity",
    "unit_cost",
    "original_cost",
    "document",
    "journal_entry_id",
  ],
};
function nativeLink(row: Row, key: string, label: string) {
  if (key === "journal_entry_id" && row[key])
    return (
      <Link
        className="text-teal-700 hover:underline"
        href={`/journal?entry=${row[key]}`}
      >
        {label}
      </Link>
    );
  if (key === "document" && row.document_id)
    return (
      <Link
        className="text-teal-700 hover:underline"
        href={`/inventory?reportRecord=${row.document_id}&reportRecordKind=${row.document_kind}`}
      >
        {label}
      </Link>
    );
  return label;
}
export function StockControls({
  view,
  itemId,
  stockLocationId,
  layerId,
  canManage = false,
  canPost = false,
  pickers,
}: {
  view: InventoryInquiry;
  itemId?: string;
  stockLocationId?: string;
  layerId?: string;
  canManage?: boolean;
  canPost?: boolean;
  pickers?: StockControlPickers;
}) {
  const t = useTranslations("inventory.controls");
  const inventory = useTranslations("inventory");
  const pathname = usePathname(),
    router = useRouter(),
    url = useSearchParams();
  const pageKey =
    view === "layers"
      ? "layerPage"
      : view === "consumptions"
        ? "layerIssuePage"
        : "stockControlPage";
  const searchKey =
    view === "layers"
      ? "layerSearch"
      : view === "consumptions"
        ? "layerIssueSearch"
        : "stockControlSearch";
  const requestedPage = Number(url.get(pageKey) ?? "1");
  const urlSearch = url.get(searchKey) ?? "";
  const urlClosed = url.get("layerIncludeClosed") === "true";
  const page =
    Number.isSafeInteger(requestedPage) &&
    requestedPage >= 1 &&
    requestedPage <= 100001
      ? requestedPage - 1
      : 0;
  const [rows, setRows] = useState<Row[]>([]),
    [search, setSearch] = useState(urlSearch),
    [total, setTotal] = useState(0);
  function resetPage() {
    if (page !== 0) {
      const next = new URLSearchParams(url.toString());
      next.delete(pageKey);
      router.replace(`${pathname}?${next}`);
    }
  }
  const [closed, setClosed] = useState(urlClosed),
    [loading, setLoading] = useState(false),
    [error, setError] = useState<string | null>(null),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    setSearch(urlSearch);
  }, [urlSearch]);
  useEffect(() => {
    setClosed(urlClosed);
  }, [urlClosed]);
  const selectedLayer = view === "layers" ? url.get("costLayer") : null;
  const selectedCustody = view === "consignment" ? url.get("custody") : null;
  function recordHref(key: "costLayer" | "custody", id: string | null) {
    const next = new URLSearchParams(url.toString());
    next.set(searchKey, search);
    next.set(pageKey, String(page + 1));
    if (view === "layers") next.set("layerIncludeClosed", String(closed));
    if (id) next.set(key, id);
    else next.delete(key);
    return `${pathname}?${next}`;
  }
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          view,
          page: String(page),
          search,
          includeClosed: String(closed),
        });
        if (itemId) params.set("itemId", itemId);
        if (stockLocationId) params.set("stockLocationId", stockLocationId);
        if (layerId) params.set("layerId", layerId);
        const response = await fetch(`/api/inventory/controls?${params}`, {
          signal,
        });
        if (!response.ok)
          throw new Error(await readApiErrorMessage(response, t("loadFailed")));
        const data = await response.json();
        if (signal?.aborted) return;
        setRows(data.rows);
        setTotal(data.totalCount);
        setError(null);
      } catch (e) {
        if (!signal?.aborted)
          setError(e instanceof Error ? e.message : t("loadFailed"));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [view, page, search, closed, itemId, stockLocationId, layerId, t],
  );
  useEffect(() => {
    const abort = new AbortController(),
      timer = setTimeout(() => void load(abort.signal), 150);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [load, revision]);
  const [busy, setBusy] = useState(false);
  const holdRetry = useRef<{ fingerprint: string; key: string } | null>(null);
  async function hold(row: Row) {
    const reason = await promptDialog({
      title: row.reason ? t("release") : t("hold"),
      message: t("reasonRequired"),
      multiline: true,
    });
    if (!reason) return;
    const request = {
      operation: "hold",
      kind: row.kind,
      id: row.subject_id,
      held: !row.reason,
      reason,
    };
    const fingerprint = JSON.stringify(request);
    if (holdRetry.current?.fingerprint !== fingerprint)
      holdRetry.current = { fingerprint, key: crypto.randomUUID() };
    setBusy(true);
    try {
      const response = await fetch("/api/inventory/controls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...request,
          idempotencyKey: holdRetry.current.key,
        }),
      });
      if (!response.ok)
        throw new Error(await readApiErrorMessage(response, t("saveFailed")));
      setRevision((r) => r + 1);
      holdRetry.current = null;
    } catch (e) {
      setError(e instanceof Error ? e.message : t("saveFailed"));
    } finally {
      setBusy(false);
    }
  }
  const columns: RegisteredListColumn<Row>[] = headings[view].map((key) => ({
    key,
    header: t(`columns.${key}`),
    cell: (row) => {
      const value = String(row[key] ?? "—");
      const label =
        key === "status" && view === "cycle_due"
          ? t(`statuses.${value}`)
          : key === "ownership"
            ? t(`ownership.${value}`)
            : key === "kind" && view === "holds"
              ? t(value)
              : ["kind", "source_kind"].includes(key) &&
                  inventory.has(`kind.${value}`)
                ? inventory(`kind.${value}`)
                : value;
      if (
        (view === "layers" && key === "date") ||
        (view === "consignment" && canPost && key === "item")
      )
        return (
          <Link
            className="text-teal-700 hover:underline"
            href={recordHref(
              view === "layers" ? "costLayer" : "custody",
              String(row.id),
            )}
          >
            {label}
          </Link>
        );
      return nativeLink(row, key, label);
    },
  }));
  if (view === "holds" && canManage)
    columns.push({
      key: "action",
      header: t("action"),
      cell: (row) => (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void hold(row)}
        >
          {row.reason ? t("release") : t("hold")}
        </Button>
      ),
    });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          aria-label={t("search")}
          placeholder={t("search")}
          value={search}
          onChange={(e) => {
            resetPage();
            setSearch(e.target.value);
          }}
          className="max-w-sm"
        />
        {view === "layers" ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={closed}
              onChange={(e) => {
                resetPage();
                setClosed(e.target.checked);
              }}
            />
            {t("includeClosed")}
          </label>
        ) : null}
        {view === "cycle_due" ? (
          <Link
            className="text-sm text-teal-700 hover:underline"
            href="/admin/setup/inventory-count-policies"
          >
            {t("configurePolicies")}
          </Link>
        ) : null}
        {view === "consignment" && canPost && pickers ? (
          <Button onClick={() => router.push(recordHref("custody", "new"))}>
            {t("newReceipt")}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}{" "}
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            {t("retry")}
          </Button>
        </p>
      ) : null}
      <div aria-busy={loading}>
        <RegisteredListTable
          rows={rows}
          columns={columns}
          rowKey={(r) => String(r.id)}
          empty={t("empty")}
          source="inventory_stock_controls"
          state={{ total, page: page + 1, perPage: 50 }}
          basePath={pathname}
          currentParams={{
            ...Object.fromEntries(url.entries()),
            [searchKey]: search,
            ...(view === "layers"
              ? { layerIncludeClosed: String(closed) }
              : {}),
          }}
          pageParamKey={pageKey}
          showPerPage={false}
          searchable={false}
        />
      </div>
      {selectedLayer ? (
        <AsyncUrlDrawer
          open
          stacked
          openKey={selectedLayer}
          closeHref={recordHref("costLayer", null)}
          title={t("consumptions")}
          pending={false}
          size="xl"
        >
          <StockControls
            key={selectedLayer}
            view="consumptions"
            layerId={selectedLayer}
          />
        </AsyncUrlDrawer>
      ) : null}
      {selectedCustody && canPost && pickers ? (
        <CustodyDrawerHost
          key={selectedCustody}
          stockId={selectedCustody}
          pickers={pickers}
          canManageTracking={canManage}
          closeHref={recordHref("custody", null)}
          onSaved={() => {
            router.replace(recordHref("custody", null));
            setRevision((value) => value + 1);
          }}
        />
      ) : null}
    </div>
  );
}
function CustodyDrawerHost({
  stockId,
  pickers,
  canManageTracking,
  closeHref,
  onSaved,
}: {
  stockId: string;
  pickers: StockControlPickers;
  canManageTracking: boolean;
  closeHref: string;
  onSaved: () => void;
}) {
  const t = useTranslations("inventory.controls");
  const [source, setSource] = useState<Row | null>(null),
    [pending, setPending] = useState(stockId !== "new"),
    [error, setError] = useState<string | null>(null),
    [revision, setRevision] = useState(0);
  const guard = useRef<(() => Promise<boolean>) | null>(null);
  const registerGuard = useCallback((next: (() => Promise<boolean>) | null) => {
    guard.current = next;
  }, []);
  useEffect(() => {
    if (stockId === "new") return;
    const abort = new AbortController();
    setPending(true);
    setError(null);
    void fetch(
      `/api/inventory/controls?${new URLSearchParams({ view: "consignment", stockId })}`,
      { signal: abort.signal },
    )
      .then(async (response) => {
        if (!response.ok)
          throw new Error(await readApiErrorMessage(response, t("loadFailed")));
        const data = await response.json();
        if (abort.signal.aborted) return;
        if (!data.rows[0]) throw new Error(t("empty"));
        setSource(data.rows[0]);
      })
      .catch((reason) => {
        if (!abort.signal.aborted)
          setError(reason instanceof Error ? reason.message : t("loadFailed"));
      })
      .finally(() => {
        if (!abort.signal.aborted) setPending(false);
      });
    return () => abort.abort();
  }, [stockId, revision, t]);
  return (
    <AsyncUrlDrawer
      open
      openKey={stockId}
      closeHref={closeHref}
      pending={pending}
      error={error}
      onRetry={() => setRevision((value) => value + 1)}
      beforeClose={() =>
        guard.current ? guard.current() : Promise.resolve(true)
      }
      title={stockId === "new" ? t("newReceipt") : t("custodyOperation")}
      size="lg"
    >
      {!pending && !error ? (
        <CustodyForm
          source={source}
          pickers={pickers}
          canManageTracking={canManageTracking}
          registerGuard={registerGuard}
          onSaved={onSaved}
        />
      ) : null}
    </AsyncUrlDrawer>
  );
}
function CustodyForm({
  source,
  pickers,
  canManageTracking,
  registerGuard,
  onSaved,
}: {
  source: Row | null;
  pickers: StockControlPickers;
  canManageTracking: boolean;
  registerGuard: (guard: (() => Promise<boolean>) | null) => void;
  onSaved: () => void;
}) {
  const t = useTranslations("inventory.controls");
  const common = useTranslations("common");
  const initialDate = useBusinessToday();
  const [action, setAction] = useState(source ? "take_ownership" : "receive"),
    [item, setItem] = useState(""),
    [location, setLocation] = useState(""),
    [subsidiary, setSubsidiary] = useState("");
  const [quantity, setQuantity] = useState(
      source ? String(source.quantity) : "",
    ),
    [cost, setCost] = useState(""),
    [offset, setOffset] = useState(""),
    [reason, setReason] = useState("");
  const [lot, setLot] = useState(""),
    [serial, setSerial] = useState(""),
    [date, setDate] = useState(initialDate),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const closeGuard = useDirtyClose({
    dirty:
      action !== (source ? "take_ownership" : "receive") ||
      item !== "" ||
      location !== "" ||
      subsidiary !== "" ||
      quantity !== (source ? String(source.quantity) : "") ||
      cost !== "" ||
      offset !== "" ||
      reason !== "" ||
      lot !== "" ||
      serial !== "" ||
      date !== initialDate,
    busy,
    onClose: () => {},
    message: common("feedback.unsavedChanges"),
    confirmLabel: common("confirm.discardChanges"),
  });
  useEffect(() => {
    registerGuard(closeGuard.beforeClose);
    return () => registerGuard(null);
  }, [registerGuard, closeGuard.beforeClose]);
  const retry = useRef<{ fingerprint: string; key: string } | null>(null);
  async function save() {
    const request = {
      operation: "consignment",
      action,
      stockId: source?.id,
      itemId: item || undefined,
      stockLocationId: source ? undefined : location,
      toStockLocationId: source ? location || undefined : undefined,
      subsidiaryId: subsidiary || undefined,
      quantity,
      unitCost: cost || undefined,
      offsetAccountId: offset || undefined,
      date,
      reason,
      lotId: lot || null,
      serialId: serial || null,
    };
    const fingerprint = JSON.stringify(request);
    if (retry.current?.fingerprint !== fingerprint)
      retry.current = { fingerprint, key: crypto.randomUUID() };
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/inventory/controls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...request, idempotencyKey: retry.current.key }),
      });
      if (!response.ok)
        throw new Error(await readApiErrorMessage(response, t("saveFailed")));
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("saveFailed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-4">
      {error ? (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      ) : null}
      <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
        {source ? (
          <div>
            <Label>{t("action")}</Label>
            <Select value={action} onChange={(e) => setAction(e.target.value)}>
              {["take_ownership", "transfer", "return"].map((a) => (
                <option value={a} key={a}>
                  {t(a)}
                </option>
              ))}
            </Select>
          </div>
        ) : (
          <>
            <div>
              <Label>{t("columns.item")}</Label>
              <SearchSelect
                value={item}
                onChange={(v) => {
                  setItem(v);
                  setLot("");
                  setSerial("");
                }}
                options={pickers.items.map((o) => ({
                  value: o.id,
                  label: [o.code, o.name].filter(Boolean).join(" · "),
                }))}
              />
            </div>
            <div>
              <Label>{t("entity")}</Label>
              <SearchSelect
                value={subsidiary}
                onChange={setSubsidiary}
                options={pickers.subsidiaries.map((o) => ({
                  value: o.id,
                  label: o.name,
                }))}
              />
            </div>
          </>
        )}
        {action !== "return" ? (
          <div>
            <Label>{source ? t("destination") : t("custodyLocation")}</Label>
            <SearchSelect
              value={location}
              onChange={setLocation}
              options={pickers.stockLocations.map((o) => ({
                value: o.id,
                label: o.code ?? o.id,
              }))}
            />
          </div>
        ) : null}
        <div>
          <Label>{t("columns.quantity")}</Label>
          <Input
            inputMode="decimal"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </div>
        <div>
          <Label>{t("columns.date")}</Label>
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        {action === "take_ownership" ? (
          <>
            <div>
              <Label>{t("columns.unit_cost")}</Label>
              <Input
                inputMode="decimal"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
              />
            </div>
            <div>
              <Label>{t("offset")}</Label>
              <SearchSelect
                value={offset}
                onChange={setOffset}
                options={pickers.accounts.map((o) => ({
                  value: o.id,
                  label: [o.number, o.name].filter(Boolean).join(" · "),
                }))}
              />
            </div>
          </>
        ) : null}
        {!source ? (
          <div className="sm:col-span-2">
            <InventoryTrackingFields
              key={item}
              itemId={item}
              lotId={lot}
              serialId={serial}
              onChange={(l, s) => {
                setLot(l);
                setSerial(s);
              }}
              canCreate={canManageTracking}
            />
          </div>
        ) : null}
        <div className="sm:col-span-2">
          <Label>{t("columns.reason")}</Label>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </fieldset>
      <Button disabled={busy} onClick={() => void save()}>
        {t("save")}
      </Button>
    </div>
  );
}
