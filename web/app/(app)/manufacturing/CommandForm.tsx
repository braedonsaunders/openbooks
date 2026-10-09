"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Button,
  Input,
  Label,
  Select,
  SearchSelect,
  Textarea,
} from "@openbooks/ui";
import { readApiErrorMessage } from "@/lib/api-error";
import type { ManufacturingRecordData } from "@openbooks/engine/src/manufacturing/workspace.ts";
import { commandBody, type Choice, type Command, type Field } from "./commands";

type Line = Record<string, string> & { key: string };
export function CommandForm({
  command,
  data,
  onSaved,
  onCancel,
  onReview,
  onDirty,
}: {
  command: Command;
  data?: ManufacturingRecordData;
  onSaved: (
    result: Record<string, unknown>,
    command: Command,
    pending: boolean,
  ) => Promise<void>;
  onCancel: () => void;
  onReview: (id?: string) => void;
  onDirty?: () => void;
}) {
  const t = useTranslations("manufacturing"),
    id = useId();
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      command.fields.map((f) => [
        f.key,
        f.initial ?? (f.type === "boolean" ? false : ""),
      ]),
    ),
  );
  const [lines, setLines] = useState<Line[]>([]),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false);
  const lock = useRef(false),
    requestKey = useRef<string | null>(null),
    sentBody = useRef<string | null>(null);
  const set = (key: string, value: unknown) => {
    onDirty?.();
    setValues((v) => ({ ...v, [key]: value }));
  };
  function label(value: string) {
    return t.has("values." + value) ? t("values." + value) : value;
  }
  function control(f: Field) {
    const value = values[f.key];
    return (
      <div key={f.key} className="space-y-1.5">
        <Label htmlFor={id + "-" + f.key}>
          {t("fields." + f.key)}
          {f.required ? " *" : ""}
        </Label>
        {f.type === "select" && remoteKind(f.key) ? (
          <RemoteChoice
            id={id + "-" + f.key}
            value={String(value ?? "")}
            options={f.options ?? []}
            endpoint={"/api/manufacturing/options?kind=" + remoteKind(f.key)}
            disabled={busy || uncertain}
            clearable={!f.required}
            onChange={(choice) => {
              set(f.key, choice);
              onDirty?.();
              if (f.key === "producedItemId") set("routingId", "");
            }}
          />
        ) : f.type === "select" ? (
          <Select
            id={id + "-" + f.key}
            value={String(value ?? "")}
            required={f.required}
            disabled={busy || uncertain}
            onChange={(e) => {
              set(f.key, e.target.value);
              if (f.key === "producedItemId") set("routingId", "");
            }}
          >
            <option value="">{t("choose")}</option>
            {(f.options ?? [])
              .filter(
                (o) =>
                  f.key !== "routingId" ||
                  !values.producedItemId ||
                  o.parentId === values.producedItemId,
              )
              .map((o) => (
                <option key={o.value} value={o.value}>
                  {label(o.label)}
                </option>
              ))}
          </Select>
        ) : f.type === "boolean" ? (
          <Select
            id={id + "-" + f.key}
            value={value === true ? "yes" : "no"}
            disabled={busy || uncertain}
            onChange={(e) => set(f.key, e.target.value === "yes")}
          >
            <option value="yes">{t("yes")}</option>
            <option value="no">{t("no")}</option>
          </Select>
        ) : f.type === "reason" ? (
          <Textarea
            id={id + "-" + f.key}
            value={String(value ?? "")}
            required={f.required}
            minLength={f.minLength}
            maxLength={command.key === "dismiss" ? 1000 : 500}
            disabled={busy || uncertain}
            onChange={(e) => set(f.key, e.target.value)}
          />
        ) : (
          <Input
            id={id + "-" + f.key}
            value={String(value ?? "")}
            type={
              f.type === "date"
                ? "date"
                : f.type === "integer"
                  ? "number"
                  : "text"
            }
            inputMode={
              f.type === "decimal"
                ? "decimal"
                : f.type === "integer"
                  ? "numeric"
                  : undefined
            }
            min={
              f.type === "integer"
                ? command.key === "create" && f.key === "horizonDays"
                  ? 1
                  : 1
                : undefined
            }
            max={f.key === "horizonDays" ? 366 : undefined}
            step={f.type === "integer" ? 1 : undefined}
            required={f.required}
            pattern={
              f.type === "decimal"
                ? "(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,4})?"
                : undefined
            }
            disabled={busy || uncertain}
            onChange={(e) => {
              set(f.key, e.target.value);
              if (f.key === "producedItemId") set("routingId", "");
            }}
          />
        )}
      </div>
    );
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current || uncertain) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    let received = false;
    try {
      for (const f of command.fields)
        if (f.required && (values[f.key] === undefined || values[f.key] === ""))
          throw new Error(t("choose") + " · " + t("fields." + f.key));
      const body = commandBody(command, values);
      if (command.repeat === "issue") {
        if (!lines.length) throw new Error(t("issueLinesRequired"));
        for (const line of lines) {
          const material = data?.sections.materials?.find(
            (m) => m.id === line.materialId,
          );
          const policy = String(material?.tracking ?? "none");
          if (
            !line.materialId ||
            !line.quantity ||
            (policy.includes("lot") && !line.lotId) ||
            (policy.includes("serial") && !line.serialId)
          )
            throw new Error(t("choose") + " · " + t("issueLines"));
        }
        body.lines = lines.map(
          ({ key, materialId, quantity, lotId, serialId }) => ({
            materialId,
            quantity,
            ...(lotId ? { lotId } : {}),
            ...(serialId ? { serialId } : {}),
          }),
        );
      }
      if (command.repeat === "tracking") {
        if (lines.length)
          body.lots = lines.map(
            ({
              key,
              itemId,
              quantity,
              lotNumber,
              serialNumber,
              expiresOn,
            }) => ({
              quantity,
              ...(itemId ? { itemId } : {}),
              ...(lotNumber ? { lotNumber } : {}),
              ...(serialNumber ? { serialNumber } : {}),
              ...(expiresOn ? { expiresOn } : {}),
            }),
          );
        const byproductValues = (command.byproducts ?? [])
          .filter(
            (b) =>
              values["nrvUnit:" + b.itemId] !== undefined &&
              values["nrvUnit:" + b.itemId] !== "",
          )
          .map((b) => ({
            itemId: b.itemId,
            nrvUnit: values["nrvUnit:" + b.itemId],
            reason: values["nrvReason:" + b.itemId] ?? "",
          }));
        if (byproductValues.length) body.byproductValues = byproductValues;
      }
      const serialized = JSON.stringify(body);
      if (!requestKey.current || sentBody.current !== serialized) {
        requestKey.current = crypto.randomUUID();
        sentBody.current = serialized;
      }
      const response = await fetch(command.path, {
        method: command.method ?? "POST",
        headers: {
          "Content-Type": "application/json",
          ...(command.create ? { "Idempotency-Key": requestKey.current } : {}),
        },
        body: serialized,
      });
      received = true;
      if (!response.ok)
        throw new Error(
          await readApiErrorMessage(response, t("commandFailed")),
        );
      let result: Record<string, unknown>;
      try {
        result = await response.json();
      } catch {
        setUncertain(true);
        throw new Error(t("uncertain"));
      }
      await onSaved(result, command, response.status === 202);
    } catch (cause) {
      if (!received && sentBody.current) {
        setUncertain(true);
        setError(t("uncertain"));
      } else
        setError(cause instanceof Error ? cause.message : t("commandFailed"));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <form
      onChange={onDirty}
      onSubmit={submit}
      className="space-y-4 rounded-xl border border-slate-200 p-4 dark:border-slate-800"
      aria-busy={busy}
    >
      <h3 className="font-semibold">{t("actions." + command.key)}</h3>
      {command.note ? (
        <p className="text-sm text-slate-500">{t(command.note)}</p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        {command.fields.map(control)}
      </div>
      {command.repeat ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold">
              {t(command.repeat === "issue" ? "issueLines" : "trackingLines")}
            </h4>
            <Button
              type="button"
              variant="outline"
              disabled={busy || uncertain}
              onClick={() =>
                setLines((v) => [
                  ...v,
                  {
                    key: crypto.randomUUID(),
                    quantity: command.repeat === "tracking" ? "1" : "",
                  },
                ])
              }
            >
              {t("addLine")}
            </Button>
          </div>
          {lines.map((line, index) => (
            <CaptureLine
              key={line.key}
              line={line}
              index={index}
              mode={command.repeat!}
              data={data}
              disabled={busy || uncertain}
              onChange={(patch) => {
                onDirty?.();
                setLines((v) =>
                  v.map((x) => (x.key === line.key ? { ...x, ...patch } : x)),
                );
              }}
              onRemove={() =>
                setLines((v) => v.filter((x) => x.key !== line.key))
              }
            />
          ))}
          {command.repeat === "tracking" ? (
            <p className="text-xs text-slate-500">{t("trackingNote")}</p>
          ) : null}
        </div>
      ) : null}
      {command.byproducts?.length ? (
        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">
            {t("byproductValues")}
          </legend>
          <p className="text-xs text-slate-500">{t("byproductNote")}</p>
          {command.byproducts.map((b) => (
            <div key={b.id} className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={id + "-nrv-" + b.id}>
                  {String(b.itemName)} · {t("fields.nrvUnit")}
                </Label>
                <Input
                  id={id + "-nrv-" + b.id}
                  inputMode="decimal"
                  value={String(values["nrvUnit:" + b.itemId] ?? "")}
                  disabled={busy || uncertain}
                  onChange={(e) => set("nrvUnit:" + b.itemId, e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={id + "-reason-" + b.id}>
                  {t("fields.reason")}
                </Label>
                <Input
                  id={id + "-reason-" + b.id}
                  minLength={5}
                  required={!!values["nrvUnit:" + b.itemId]}
                  value={String(values["nrvReason:" + b.itemId] ?? "")}
                  disabled={busy || uncertain}
                  onChange={(e) => set("nrvReason:" + b.itemId, e.target.value)}
                />
              </div>
            </div>
          ))}
        </fieldset>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {uncertain ? (
          <Button
            type="button"
            onClick={() =>
              onReview(
                command.opensRecord
                  ? (requestKey.current ?? undefined)
                  : undefined,
              )
            }
          >
            {t("reviewRecord")}
          </Button>
        ) : (
          <Button type="submit" disabled={busy}>
            {busy ? t("saving") : t("actions." + command.key)}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={onCancel}
        >
          {t("cancelForm")}
        </Button>
      </div>
    </form>
  );
}
function CaptureLine({
  line,
  index,
  mode,
  data,
  disabled,
  onChange,
  onRemove,
}: {
  line: Line;
  index: number;
  mode: "issue" | "tracking";
  data?: ManufacturingRecordData;
  disabled: boolean;
  onChange: (patch: Record<string, string>) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("manufacturing"),
    id = useId();
  const [tracking, setTracking] = useState<{
      lots: Choice[];
      serials: Choice[];
    }>({ lots: [], serials: [] }),
    [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(false),
    [attempt, setAttempt] = useState(0);
  const material = data?.sections.materials?.find(
      (m) => m.id === line.materialId,
    ),
    itemId = String(material?.itemId ?? "");
  useEffect(() => {
    if (mode !== "issue" || !itemId) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setTracking({ lots: [], serials: [] });
    fetch("/api/manufacturing/tracking/" + itemId, {
      signal: controller.signal,
    })
      .then(async (r) => {
        if (!r.ok)
          throw new Error(await readApiErrorMessage(r, t("loadFailed")));
        return r.json();
      })
      .then((v) => setTracking(v))
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : t("loadFailed"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [mode, itemId, t, attempt]);
  const input = (key: string, required = false, type = "text") => (
    <div className="space-y-1.5">
      <Label htmlFor={id + "-" + key}>{t("fields." + key)}</Label>
      <Input
        id={id + "-" + key}
        value={line[key] ?? ""}
        required={required}
        type={type}
        disabled={disabled}
        inputMode={key === "quantity" ? "decimal" : undefined}
        onChange={(e) => onChange({ [key]: e.target.value })}
      />
    </div>
  );
  const choice = (key: string, options: Choice[], required = false) => (
    <div className="space-y-1.5">
      <Label htmlFor={id + "-" + key}>{t("fields." + key)}</Label>
      {mode === "issue" && (key === "lotId" || key === "serialId") ? (
        <RemoteChoice
          id={id + "-" + key}
          value={line[key] ?? ""}
          options={options}
          endpoint={
            "/api/manufacturing/tracking/" +
            itemId +
            (key === "serialId" && line.lotId ? "?lotId=" + line.lotId : "")
          }
          resultKey={key === "lotId" ? "lots" : "serials"}
          disabled={disabled}
          clearable={!required}
          onChange={(value) =>
            onChange(
              key === "lotId"
                ? { lotId: value, serialId: "" }
                : { serialId: value },
            )
          }
        />
      ) : (
        <Select
          id={id + "-" + key}
          value={line[key] ?? ""}
          disabled={disabled || loading}
          required={required}
          onChange={(e) =>
            onChange(
              key === "materialId"
                ? { materialId: e.target.value, lotId: "", serialId: "" }
                : key === "lotId"
                  ? { lotId: e.target.value, serialId: "" }
                  : { [key]: e.target.value },
            )
          }
        >
          <option value="">{t("choose")}</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      )}
    </div>
  );
  const policy = String(material?.tracking ?? "none");
  return (
    <fieldset className="space-y-3 rounded-lg bg-slate-50 p-3 dark:bg-slate-950">
      <legend className="text-xs font-semibold">
        {t("line", { number: index + 1 })}
      </legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {mode === "issue"
          ? choice(
              "materialId",
              (data?.sections.materials ?? []).map((m) => ({
                value: m.id,
                label: String(m.itemCode ?? "") + " · " + m.itemName,
              })),
              true,
            )
          : choice(
              "itemId",
              [
                {
                  value: String(data?.record.producedItemId ?? ""),
                  label: String(data?.record.itemName ?? ""),
                },
                ...(data?.sections.byproducts ?? []).map((b) => ({
                  value: String(b.itemId),
                  label: String(b.itemName),
                })),
              ],
              true,
            )}
        {input("quantity", true)}
        {mode === "issue" ? (
          <>
            {policy === "lot" || policy === "lot_serial"
              ? choice("lotId", tracking.lots, true)
              : null}
            {policy === "serial" || policy === "lot_serial"
              ? choice(
                  "serialId",
                  tracking.serials.filter(
                    (s) => !line.lotId || s.parentId === line.lotId,
                  ),
                  true,
                )
              : null}
          </>
        ) : (
          <>
            {input("lotNumber")}
            {input("serialNumber")}
            {input("expiresOn", false, "date")}
          </>
        )}
      </div>
      {error ? (
        <div role="alert" className="text-sm text-red-600">
          {error}
          <Button
            type="button"
            variant="outline"
            onClick={() => setAttempt((v) => v + 1)}
          >
            {t("retry")}
          </Button>
        </div>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={onRemove}
      >
        {t("removeLine")}
      </Button>
    </fieldset>
  );
}

const remoteKind = (key: string) =>
  key === "producedItemId"
    ? "items"
    : key === "vendorId"
      ? "vendors"
      : key.endsWith("LocationId")
        ? "locations"
        : null;

/** Search results and retries stay inside the house reference-picker shell. */
function RemoteChoice({
  id,
  value,
  options,
  endpoint,
  resultKey,
  disabled,
  clearable,
  onChange,
}: {
  id: string;
  value: string;
  options: Choice[];
  endpoint: string;
  resultKey?: "lots" | "serials";
  disabled: boolean;
  clearable: boolean;
  onChange: (value: string) => void;
}) {
  const t = useTranslations("manufacturing");
  const [query, setQuery] = useState(""),
    [rows, setRows] = useState(options),
    [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(false),
    [attempt, setAttempt] = useState(0);
  const chosen = useRef<Choice | undefined>(
    options.find((o) => o.value === value),
  );
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      setError(null);
      const url = new URL(endpoint, window.location.origin);
      url.searchParams.set("q", query);
      if (value) url.searchParams.set("selected", value);
      fetch(url.pathname + url.search, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok)
            throw new Error(
              await readApiErrorMessage(response, t("loadFailed")),
            );
          const data = await response.json();
          return (resultKey ? data[resultKey] : data) as Choice[];
        })
        .then((result) => {
          if (!controller.signal.aborted) {
            setRows(result);
            const selected = result.find((o) => o.value === value);
            if (selected) chosen.current = selected;
          }
        })
        .catch((cause) => {
          if (!controller.signal.aborted) {
            setRows([]);
            setError(cause instanceof Error ? cause.message : t("loadFailed"));
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [endpoint, query, value, resultKey, t, attempt]);
  const selected =
    rows.find((o) => o.value === value) ??
    (chosen.current?.value === value ? chosen.current : undefined);
  const choices =
    selected && !rows.some((o) => o.value === value)
      ? [selected, ...rows]
      : rows;
  return (
    <div className="space-y-1">
      <SearchSelect
        id={id}
        ariaLabel={t("choose")}
        value={value}
        options={choices}
        onChange={(next) => {
          chosen.current = choices.find((o) => o.value === next);
          onChange(next);
        }}
        placeholder={t("choose")}
        searchPlaceholder={t("searchPlaceholder")}
        disabled={disabled}
        clearable={clearable}
        emptyLabel={t("choose")}
        remote
        searchable
        loading={loading}
        onSearchChange={(q) => setQuery(q.slice(0, 200))}
        statusMessage={error ?? undefined}
        statusTone={error ? "error" : "muted"}
      />
      {error ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => setAttempt((a) => a + 1)}
        >
          {t("retry")}
        </Button>
      ) : null}
    </div>
  );
}
