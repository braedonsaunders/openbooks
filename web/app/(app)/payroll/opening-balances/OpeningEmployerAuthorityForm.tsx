"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Alert,
  AlertDescription,
  Button,
  FieldLabel,
  Input,
  Select,
  Skeleton,
} from "@openbooks/ui";
import { CabinetFilePicker } from "../../../../components/cabinet-file-picker";
import { readApiErrorMessage } from "../../../../lib/api-error";
import type { readOpeningEmployerContext } from "@openbooks/engine/payroll/opening-employer-authority";
type Context = Awaited<ReturnType<typeof readOpeningEmployerContext>>;
type State = (
  { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; context: Context }
) & { requestKey: string };
type Props = {
  employeePartyId: string;
  year: number;
  canManage: boolean;
  annualDirty: boolean;
  onSaved: () => void;
};
/** Source ownership is reviewed in the existing selected-employee drawer. */
export function OpeningEmployerAuthorityForm(props: Props) {
  return (
    <OpeningEmployerAuthorityBody
      key={JSON.stringify([props.employeePartyId, props.year])}
      {...props}
    />
  );
}
function OpeningEmployerAuthorityBody({
  employeePartyId,
  year,
  canManage,
  annualDirty,
  onSaved,
}: Props) {
  const t = useTranslations("payroll");
  const text = (key: string, fallback: string) =>
    t.has(("openingBalances.employerAuthority." + key) as never)
      ? t(("openingBalances.employerAuthority." + key) as never)
      : fallback;
  const [fileId, setFileId] = useState(""),
    [subsidiaryId, setSubsidiaryId] = useState("");
  const [sourceReference, setSourceReference] = useState(""),
    [reason, setReason] = useState(""),
    [reload, setReload] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const requestKey = JSON.stringify([employeePartyId, year, fileId, reload]);
  const [state, setState] = useState<State>({ kind: "loading", requestKey });
  if (state.requestKey !== requestKey) setState({ kind: "loading", requestKey });
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timeout = setTimeout(() => controller.abort(), 15000);
    void (async () => {
      const params = new URLSearchParams({ employeePartyId, taxYear: String(year) });
      if (fileId) params.set("sourceFileId", fileId);
      const response = await fetch("/api/payroll/opening-balances/employer-authority?" + params, {
        signal: controller.signal,
      });
      if (!response.ok)
        throw Error(await readApiErrorMessage(response, "The opening source could not be loaded"));
      const context = (await response.json()) as Context;
      if (active) setState({ kind: "ready", context, requestKey });
    })()
      .catch((cause: unknown) => {
        if (active)
          setState({
            kind: "error",
            message:
              cause instanceof Error ? cause.message : "The opening source could not be loaded",
            requestKey,
          });
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [employeePartyId, year, fileId, requestKey]);
  async function save() {
    if (
      state.kind !== "ready" ||
      !state.context.record ||
      !state.context.source ||
      !canManage ||
      annualDirty ||
      busy
    )
      return;
    const { record, source } = state.context;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/payroll/opening-balances/employer-authority", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          openingBalanceId: record.id,
          expectedOpeningSha256: record.openingSha256,
          subsidiaryId,
          sourceFileId: source.id,
          sourceVersionId: source.versionId,
          sourceSha256: source.sha256,
          sourceReference,
          reason,
        }),
      });
      if (!response.ok)
        throw Error(
          await readApiErrorMessage(response, "The opening employer source could not be qualified"),
        );
      setReload((value) => value + 1);
      onSaved();
    } catch (cause: unknown) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The opening employer source could not be qualified",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-4">
      <p className="text-sm text-slate-500">
        {text(
          "help",
          "Identify the legal employer from the original opening report. Qualification retains the original amounts and source; it does not change posted payroll.",
        )}
      </p>
      {state.kind === "loading" && <Skeleton className="h-24 w-full" />}
      {state.kind === "error" && (
        <>
          <Alert variant="warning">
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
          <Button variant="outline" onClick={() => setReload((value) => value + 1)}>
            {text("retry", "Retry")}
          </Button>
        </>
      )}
      {state.kind === "ready" &&
        (!state.context.record ? (
          <p>
            {text(
              "noOpening",
              "Save the employee’s opening amounts before qualifying their employer source.",
            )}
          </p>
        ) : state.context.record.authorityId ? (
          <Alert>
            <AlertDescription>
              {text("qualified", "Original employer source qualified and retained.")}{" "}
              {
                state.context.employers.find((e) => e.id === state.context.record?.subsidiaryId)
                  ?.name
              }
              {" · "}
              {state.context.record.sourceReference}
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {annualDirty && (
              <Alert variant="warning">
                <AlertDescription>
                  {text(
                    "saveFirst",
                    "Save the changed opening amounts before qualifying their source.",
                  )}
                </AlertDescription>
              </Alert>
            )}
            <div>
              <FieldLabel htmlFor="opening-source-employer">
                {text("employer", "Original legal employer")}
              </FieldLabel>
              <Select
                id="opening-source-employer"
                value={subsidiaryId}
                onChange={(event) => setSubsidiaryId(event.target.value)}
                disabled={!canManage || busy}
              >
                <option value="">
                  {text("chooseEmployer", "Choose the employer named by the source")}
                </option>
                {state.context.employers.map((employer) => (
                  <option key={employer.id} value={employer.id}>
                    {employer.name}
                  </option>
                ))}
              </Select>
            </div>
            <CabinetFilePicker
              value={fileId}
              onChange={setFileId}
              label={text("file", "Original opening report in File Cabinet")}
              disabled={!canManage || busy}
            />
            <div>
              <FieldLabel htmlFor="opening-source-reference">
                {text("reference", "Employee and employer reference in the source")}
              </FieldLabel>
              <Input
                id="opening-source-reference"
                value={sourceReference}
                onChange={(event) => setSourceReference(event.target.value)}
                maxLength={2000}
                disabled={!canManage || busy}
              />
            </div>
            <div>
              <FieldLabel htmlFor="opening-source-reason">
                {text("reason", "Qualification reason")}
              </FieldLabel>
              <Input
                id="opening-source-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={2000}
                disabled={!canManage || busy}
              />
            </div>
            {error && (
              <Alert variant="warning">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {canManage && (
              <Button
                onClick={() => void save()}
                disabled={
                  busy ||
                  annualDirty ||
                  !subsidiaryId ||
                  !state.context.source ||
                  !sourceReference.trim() ||
                  !reason.trim()
                }
              >
                {busy
                  ? text("saving", "Saving…")
                  : text("qualify", "Qualify original employer source")}
              </Button>
            )}
          </>
        ))}
    </section>
  );
}
