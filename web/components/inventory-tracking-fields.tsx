"use client";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Label, SearchSelect, Skeleton } from "@openbooks/ui";
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
  optionsEndpoint,
  registerIdentifier,
}: {
  itemId: string;
  lotId: string;
  serialId: string;
  onChange: (lot: string, serial: string) => void;
  disabled?: boolean;
  canCreate?: boolean;
  /** Owning commands may narrow the native catalog through their record authority. */
  optionsEndpoint?: string;
  registerIdentifier?: (kind:"lot"|"serial",number:string,expiresOn:string|null)=>Promise<{id:string}>;
}) {
  const t = useTranslations("inventory.controls");
  const [search, setSearch] = useState(""),
    [revision, setRevision] = useState(0),
    [error, setError] = useState<string | null>(null);
  const [loading,setLoading]=useState(false),[creating,setCreating]=useState(false),[loadedKey,setLoadedKey]=useState('');
  const recordKey=itemId+':'+(optionsEndpoint??'');
  const currentKey=useRef(recordKey),createLock=useRef(false),mounted=useRef(true);
  currentKey.current=recordKey;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
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
      if (lotId) query.set("selectedLotId",lotId);
      if (serialId) query.set("selectedSerialId",serialId);
      setLoading(true);
      void fetch(`${optionsEndpoint??'/api/inventory/tracking-options'}?${query}`, {
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
          setLoadedKey(recordKey);
          setError(null);
        })
        .catch((e) => {
          if (!abort.signal.aborted)
            setError(e instanceof Error ? e.message : t("loadFailed"));
        }).finally(()=>{if(!abort.signal.aborted)setLoading(false);});
    }, 150);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [itemId, lotId,serialId, search, revision, t,optionsEndpoint,recordKey]);
  async function create(kind: "lot" | "serial") {
    if (createLock.current || disabled) return;
    createLock.current=true;
    const identity=recordKey;
    setCreating(true);
    try {
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
      if (!mounted.current||currentKey.current!==identity) return;
      let saved:{id:string};
      if(registerIdentifier) saved=await registerIdentifier(kind,number,expiry?.trim()||null);
      else {
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
      saved = await response.json();
      }
      if (!mounted.current||currentKey.current!==identity) return;
      onChange(
        kind === "lot" ? saved.id : lotId,
        kind === "serial" ? saved.id : "",
      );
      setSearch("");
      setRevision((r) => r + 1);
    } catch (e) {
      if (mounted.current&&currentKey.current===identity) setError(e instanceof Error ? e.message : t("saveFailed"));
    } finally {createLock.current=false;if(mounted.current)setCreating(false);}
  }
  const visible=loadedKey===recordKey?data:null;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {!visible&&!error&&itemId?<><Skeleton className="h-14"/><Skeleton className="h-14"/></>:null}
      {error ? (
        <p role="alert" className="text-sm text-red-600 sm:col-span-2">
          {error}
          <Button type="button" size="sm" variant="outline" onClick={()=>setRevision(value=>value+1)}>{t('retry')}</Button>
        </p>
      ) : null}
      {visible?.tracking === "lot" || visible?.tracking === "lot_serial" ? (
        <div>
          <Label>{t("lot")}</Label>
          <SearchSelect
            value={lotId}
            onChange={(v) => onChange(v, "")}
            options={visible.lots.map((o) => ({
              value: o.id,
              label: [o.label, o.expiry, o.hold_reason ? t("held") : null]
                .filter(Boolean)
                .join(" · "),
            }))}
            remote
            onSearchChange={setSearch}
            disabled={disabled||creating}
            loading={loading}
            ariaLabel={t("lot")}
          />
          {canCreate ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled||creating}
              onClick={() => void create("lot")}
            >
              {t("newLot")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {visible?.tracking === "serial" || visible?.tracking === "lot_serial" ? (
        <div>
          <Label>{t("serial")}</Label>
          <SearchSelect
            value={serialId}
            onChange={(v) =>
              onChange(visible.serials.find((o) => o.id === v)?.lot_id ?? lotId, v)
            }
            options={visible.serials.map((o) => ({ value: o.id, label: o.label }))}
            remote
            onSearchChange={setSearch}
            disabled={disabled||creating}
            loading={loading}
            ariaLabel={t("serial")}
          />
          {canCreate ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled||creating}
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
