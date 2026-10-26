"use client";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, FieldLabel, Input, Skeleton } from "@openbooks/ui";
import { CabinetFilePicker } from "../../../../components/cabinet-file-picker";
import { readApiErrorMessage } from "../../../../lib/api-error";
import type { RoeSeparationFacts } from "@openbooks/engine/payroll/roe-separation-facts";
import type { readRoeSubsequentServiceContext } from "@openbooks/engine/payroll/canada/roe-subsequent-service";
import { DateField } from "../../../../components/date-field";
type Context = Awaited<ReturnType<typeof readRoeSubsequentServiceContext>>;
type State = (
  { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; context: Context }
) & { requestKey: string };

/** The certificate belongs to the selected interruption and its original employment. */
type Props = {
  employeePartyId: string;
  event: RoeSeparationFacts;
  canEdit: boolean;
  onSaved: () => void;
};
export function RoeSubsequentServiceForm(props: Props) {
  return (
    <RoeSubsequentServiceBody
      key={JSON.stringify([
        props.employeePartyId,
        props.event.id,
        props.event.employmentId,
        props.event.subsidiaryId,
      ])}
      {...props}
    />
  );
}
function RoeSubsequentServiceBody({ employeePartyId, event, canEdit, onSaved }: Props) {
  const t = useTranslations("payroll.filings.subsequentService");
  const hydrated = useRef("");
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [fileId, setFileId] = useState(""),
    [firstDayWorked, setFirstDayWorked] = useState("");
  const [sourceReference, setSourceReference] = useState(""),
    [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [reload, setReload] = useState(0);
  const requestKey = JSON.stringify([
    employeePartyId,
    event.id,
    event.employmentId,
    event.subsidiaryId,
    fileId,
    reload,
  ]);
  const [state, setState] = useState<State>({ kind: "loading", requestKey });
  if (state.requestKey !== requestKey) setState({ kind: "loading", requestKey });
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(() => controller.abort(), 15000);
    void (async () => {
      if (!event.employmentId || !event.subsidiaryId) throw new Error(t("missingScope"));
      const params = new URLSearchParams({
        employeePartyId,
        employmentId: event.employmentId,
        subsidiaryId: event.subsidiaryId,
        precedingEventId: event.id,
      });
      if (fileId) params.set("sourceFileId", fileId);
      const response = await fetch("/api/payroll/separations/subsequent-service?" + params, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await readApiErrorMessage(response, t("loadFailed")));
      const context = (await response.json()) as Context;
      if (!active) return;
      setState({ kind: "ready", context, requestKey });
      const record = context.record;
      if (record && hydrated.current !== record.id + ":" + record.updatedAt) {
        hydrated.current = record.id + ":" + record.updatedAt;
        setFirstDayWorked(record.firstDayWorked);
        setSourceReference(record.sourceReference);
        setReason(record.reason);
      }
    })()
      .catch((cause: unknown) => {
        if (active)
          setState({
            kind: "error",
            message: cause instanceof Error ? cause.message : t("loadFailed"),
            requestKey,
          });
      })
      .finally(() => clearTimeout(timer));
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [employeePartyId, event.id, event.employmentId, event.subsidiaryId, fileId, requestKey, t]);
  const record = state.kind === "ready" ? state.context.record : null;
  const disabled =
    !canEdit || busy || event.status !== "confirmed" || !event.employmentId || !event.subsidiaryId;
  async function save() {
    if (disabled || state.kind !== "ready" || !state.context.source) return;
    const { source, record: current } = state.context;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/payroll/separations/subsequent-service", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeePartyId,
          employmentId: event.employmentId,
          subsidiaryId: event.subsidiaryId,
          precedingEventId: event.id,
          firstDayWorked,
          sourceFileId: source.id,
          sourceVersionId: source.versionId,
          sourceSha256: source.sha256,
          sourceReference,
          reason,
          expectedId: current?.id ?? null,
          expectedUpdatedAt: current?.updatedAt ?? null,
        }),
      });
      if (!response.ok) throw new Error(await readApiErrorMessage(response, t("saveFailed")));
      const body = (await response.json()) as { record: NonNullable<Context["record"]> };
      if (!mounted.current) return;
      setState({ kind: "ready", context: { ...state.context, record: body.record }, requestKey });
      onSaved();
    } catch (cause: unknown) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : t("saveFailed"));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <h3 className="text-sm font-semibold">{t("title")}</h3>
      <p className="text-xs text-slate-500">{t("help")}</p>
      {event.status === "issued" && (
        <Alert>
          <AlertDescription>{t("issued")}</AlertDescription>
        </Alert>
      )}
      {canEdit && event.status === "confirmed" && (
        <CabinetFilePicker
          id="roe-return-file"
          value={fileId}
          onChange={setFileId}
          label={t("file")}
          disabled={busy}
        />
      )}
      {state.kind === "loading" && <Skeleton className="h-24 w-full" aria-label={t("loading")} />}
      {state.kind === "error" && (
        <>
          <Alert variant="warning">
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
          <Button variant="outline" onClick={() => setReload((value) => value + 1)}>
            {t("retry")}
          </Button>
        </>
      )}
      {state.kind === "ready" && (
        <>
          {record && (
            <p className="text-xs text-slate-500">
              {t("retained")}: {record.firstDayWorked} · {record.sourceReference}
            </p>
          )}
          <div>
            <FieldLabel htmlFor="roe-return-first-worked">{t("firstWorked")}</FieldLabel>
            <DateField
              id="roe-return-first-worked"
              value={firstDayWorked}
              onChange={(value) => setFirstDayWorked(value)}
              disabled={disabled}
            />
          </div>
          {state.context.source && (
            <p className="text-xs text-slate-500">{state.context.source.name}</p>
          )}
          <div>
            <FieldLabel htmlFor="roe-return-source">{t("reference")}</FieldLabel>
            <Input
              id="roe-return-source"
              value={sourceReference}
              onChange={(e) => setSourceReference(e.target.value)}
              maxLength={2000}
              disabled={disabled}
            />
          </div>
          <div>
            <FieldLabel htmlFor="roe-return-reason">{t("reason")}</FieldLabel>
            <Input
              id="roe-return-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={2000}
              disabled={disabled}
            />
          </div>
          {error && (
            <Alert variant="warning">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {canEdit && event.status === "confirmed" && (
            <Button
              onClick={() => void save()}
              disabled={
                busy ||
                !state.context.source ||
                !firstDayWorked ||
                !sourceReference.trim() ||
                !reason.trim()
              }
            >
              {busy ? t("saving") : t("save")}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
