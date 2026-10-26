"use client";
import { parseRoeEventRow, roeEventRow } from "@openbooks/engine/payroll/roe-event-row";
import Link from "next/link";
import { RecordTabs } from "../../../../components/module-home/record-tabs";
import { RoeSubsequentServiceForm } from "./roe-subsequent-service";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import type {
  RoeSeparationFacts,
  RoeSeparationEmployee,
  RoeSeparationProposal,
} from "@openbooks/engine/payroll/roe-separation-facts";
import { readApiErrorMessage } from "../../../../lib/api-error";
import { DateField } from "../../../../components/date-field";

type State = (
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      record: RoeSeparationFacts | null;
      proposal: RoeSeparationProposal | null;
      employee: RoeSeparationEmployee;
    }
) & { requestKey: string };
type Props = {
  employeePartyId: string;
  canEdit: boolean;
  onSaved: (rowId: string) => void;
  /** A bare employee row whose event already exists elsewhere (another tax year) resolves to that event. */
  onEventResolved?: (rowId: string) => void;
};

/** The employee's declaration stays in the shared ROE drawer, including refusal and retry. */
export function RoeSeparationFactsForm(props: Props) {
  return <RoeSeparationFactsBody key={props.employeePartyId} {...props} />;
}

function RoeSeparationFactsBody({ employeePartyId, canEdit, onSaved, onEventResolved }: Props) {
  const t = useTranslations("payroll.filings.separationFacts");
  const returnText = useTranslations("payroll.filings.subsequentService");
  const [activeEvidence, setActiveEvidence] = useState<"separation" | "return">("separation");
  const [reload, setReload] = useState(0);
  const [newEvent, setNewEvent] = useState(false);
  const requestKey = JSON.stringify([employeePartyId, newEvent, reload]);
  const [state, setState] = useState<State>({ status: "loading", requestKey });
  // As in the shared drawer resource, request identity clears stale data before commit.
  if (state.requestKey !== requestKey) setState({ status: "loading", requestKey });
  const selection = useMemo(() => parseRoeEventRow(employeePartyId), [employeePartyId]);
  const [firstDayWorked, setFirstDayWorked] = useState("");
  const [interruptionOn, setInterruptionOn] = useState("");
  const [lastInsurableEarningsOn, setLastInsurableEarningsOn] = useState("");
  const [salaryContinuanceEndOn, setSalaryContinuanceEndOn] = useState("");
  const [sourceReference, setSourceReference] = useState("");
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState<"draft" | "confirmed">("draft");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The host's callback is read at resolution time, never a fetch input.
  const resolveEvent = useRef(onEventResolved);
  useLayoutEffect(() => {
    resolveEvent.current = onEventResolved;
  });
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!selection) throw new Error(t("loadFailed"));
      const params = new URLSearchParams({ employeePartyId: selection.employeePartyId });
      if (newEvent) params.set("newEvent", "true");
      else if (selection.eventId) params.set("eventId", selection.eventId);
      const response = await fetch(`/api/payroll/separations/facts?${params}`);
      if (!response.ok) throw new Error(await readApiErrorMessage(response, t("loadFailed")));
      const body = (await response.json()) as {
        record: RoeSeparationFacts | null;
        proposal: RoeSeparationProposal | null;
        employee: RoeSeparationEmployee;
      };
      if (!alive) return;
      if (!selection.eventId && !newEvent && body.record && resolveEvent.current) {
        resolveEvent.current(roeEventRow(selection.employeePartyId, body.record.id));
        return;
      }
      setState({
        status: "ready",
        record: body.record,
        proposal: body.proposal,
        employee: body.employee,
        requestKey,
      });
      // A new event starts from the employment's own records; the employer's
      // save is the declaration, so a fully supported proposal is offered as
      // confirmed and every date stays editable before saving.
      const proposal = body.record ? null : body.proposal;
      setFirstDayWorked(body.record?.firstDayWorked ?? proposal?.firstDayWorked ?? "");
      setInterruptionOn(body.record?.interruptionOn ?? proposal?.interruptionOn ?? "");
      setLastInsurableEarningsOn(
        body.record?.lastInsurableEarningsOn ?? proposal?.lastInsurableEarningsOn ?? "",
      );
      setSalaryContinuanceEndOn(body.record?.salaryContinuanceEndOn ?? "");
      setSourceReference(body.record?.sourceReference ?? proposal?.sourceReference ?? "");
      setReason(proposal ? t("proposedReason") : "");
      setStatus(
        body.record?.status === "confirmed" ||
          (proposal?.firstDayWorked && proposal.interruptionOn && proposal.lastInsurableEarningsOn)
          ? "confirmed"
          : "draft",
      );
      setError("");
    })().catch((cause: unknown) => {
      if (alive)
        setState({
          status: "error",
          message: cause instanceof Error ? cause.message : t("loadFailed"),
          requestKey,
        });
    });
    return () => {
      alive = false;
    };
  }, [selection, newEvent, requestKey, t]);

  async function save() {
    if (!canEdit || busy || state.status !== "ready" || !selection) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/payroll/separations/facts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeePartyId: selection.employeePartyId,
          employmentId: state.employee.employmentId,
          subsidiaryId: state.employee.subsidiaryId,
          firstDayWorked: firstDayWorked || null,
          interruptionOn,
          lastInsurableEarningsOn,
          salaryContinuanceEndOn: salaryContinuanceEndOn || null,
          sourceReference,
          reason,
          status,
          expectedId: state.record?.id ?? null,
          expectedUpdatedAt: state.record?.updatedAt ?? null,
        }),
      });
      if (!response.ok) throw new Error(await readApiErrorMessage(response, t("saveFailed")));
      const body = (await response.json()) as { record: RoeSeparationFacts };
      setState({
        status: "ready",
        record: body.record,
        proposal: null,
        employee: state.employee,
        requestKey,
      });
      onSaved(roeEventRow(selection.employeePartyId, body.record.id));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : t("saveFailed"));
    } finally {
      setBusy(false);
    }
  }
  const immutable = state.status === "ready" && state.record?.status === "issued";
  const disabled = !canEdit || busy || immutable;
  const factsDirty =
    state.status === "ready" &&
    state.record !== null &&
    (firstDayWorked !== (state.record.firstDayWorked ?? "") ||
      interruptionOn !== state.record.interruptionOn ||
      lastInsurableEarningsOn !== state.record.lastInsurableEarningsOn ||
      salaryContinuanceEndOn !== (state.record.salaryContinuanceEndOn ?? "") ||
      sourceReference !== (state.record.sourceReference ?? "") ||
      status !== (state.record.status === "confirmed" ? "confirmed" : "draft"));
  const returnAvailable =
    state.status === "ready" &&
    state.record !== null &&
    (state.record.status === "confirmed" || state.record.status === "issued") &&
    !factsDirty &&
    !busy;
  return (
    <section
      className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800"
      aria-label={t("title")}
    >
      <div>
        <h3 className="text-sm font-semibold">{t("title")}</h3>
        <p className="text-xs text-slate-500">{t("help")}</p>
      </div>
      {state.status === "loading" && <Skeleton className="h-24 w-full" />}
      {state.status === "error" && (
        <>
          <Alert variant="warning">
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
          <Button variant="outline" onClick={() => setReload((value) => value + 1)}>
            {t("retry")}
          </Button>
        </>
      )}
      {state.status === "ready" && (
        <RecordTabs
          label={returnText("evidenceTabs")}
          active={returnAvailable ? activeEvidence : "separation"}
          tabs={[
            { key: "separation", label: returnText("separationTab") },
            { key: "return", label: returnText("returnTab"), disabled: !returnAvailable },
          ]}
          onChange={setActiveEvidence}
        >
          <div hidden={returnAvailable && activeEvidence === "return"} className="space-y-3">
            {immutable && (
              <>
                <Alert>
                  <AlertDescription>{t("issued")}</AlertDescription>
                </Alert>
                {canEdit && (
                  <Button variant="outline" onClick={() => setNewEvent(true)}>
                    {t("newEvent")}
                  </Button>
                )}
              </>
            )}
            {!state.record && state.proposal && (
              <Alert variant="info">
                <AlertDescription>{t("proposed")}</AlertDescription>
              </Alert>
            )}
            {!state.record && !state.proposal && (
              <Alert variant="info">
                <AlertDescription>{t("noEvent")}</AlertDescription>
              </Alert>
            )}
            <p className="text-xs text-slate-500">
              {t("employer", { name: state.employee.employerName })}
            </p>
            {canEdit && !immutable && (
              <p className="text-xs text-slate-500">
                <Link className="underline underline-offset-2" href={"/data/import" as never}>
                  {t("importHistory")}
                </Link>{" "}
                {t("importHistoryHelp")}
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <FieldLabel htmlFor="roe-first-worked">{t("firstWorked")}</FieldLabel>
                <DateField
                  id="roe-first-worked"
                  value={firstDayWorked}
                  onChange={(value) => setFirstDayWorked(value)}
                  disabled={disabled}
                />
              </div>
              <div>
                <FieldLabel htmlFor="roe-interruption">{t("interruption")}</FieldLabel>
                <DateField
                  id="roe-interruption"
                  value={interruptionOn}
                  onChange={(value) => setInterruptionOn(value)}
                  disabled={disabled}
                />
              </div>
              <div>
                <FieldLabel htmlFor="roe-last-insurable">{t("lastInsurable")}</FieldLabel>
                <DateField
                  id="roe-last-insurable"
                  value={lastInsurableEarningsOn}
                  onChange={(value) => setLastInsurableEarningsOn(value)}
                  disabled={disabled}
                />
              </div>
              <div>
                <FieldLabel htmlFor="roe-continuance">{t("continuance")}</FieldLabel>
                <DateField
                  id="roe-continuance"
                  value={salaryContinuanceEndOn}
                  onChange={(value) => setSalaryContinuanceEndOn(value)}
                  disabled={disabled}
                />
              </div>
              <div>
                <FieldLabel htmlFor="roe-facts-status">{t("status")}</FieldLabel>
                <Select
                  id="roe-facts-status"
                  value={status}
                  onChange={(event) => setStatus(event.target.value as "draft" | "confirmed")}
                  disabled={disabled}
                >
                  <option value="draft">{t("draft")}</option>
                  <option value="confirmed">{t("confirmed")}</option>
                </Select>
              </div>
              <div>
                <FieldLabel htmlFor="roe-source">{t("source")}</FieldLabel>
                <Input
                  id="roe-source"
                  value={sourceReference}
                  onChange={(event) => setSourceReference(event.target.value)}
                  maxLength={2000}
                  disabled={disabled}
                />
              </div>
              <div>
                <FieldLabel htmlFor="roe-facts-reason">{t("reason")}</FieldLabel>
                <Input
                  id="roe-facts-reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  maxLength={2000}
                  disabled={disabled}
                />
              </div>
            </div>
            {factsDirty && !immutable && (
              <p className="text-xs text-slate-500">{returnText("saveFactsFirst")}</p>
            )}
            {error && (
              <Alert variant="warning">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {canEdit && !immutable && (
              <Button
                onClick={() => void save()}
                disabled={
                  disabled ||
                  !sourceReference.trim() ||
                  !reason.trim() ||
                  !interruptionOn ||
                  !lastInsurableEarningsOn ||
                  (status === "confirmed" && !firstDayWorked)
                }
              >
                {busy ? t("saving") : t("save")}
              </Button>
            )}
          </div>
          {state.record &&
            (state.record.status === "confirmed" || state.record.status === "issued") && (
              <div hidden={!returnAvailable || activeEvidence !== "return"}>
                <RoeSubsequentServiceForm
                  key={state.record.id}
                  employeePartyId={selection!.employeePartyId}
                  event={state.record}
                  canEdit={canEdit && returnAvailable}
                  onSaved={() => onSaved(roeEventRow(selection!.employeePartyId, state.record!.id))}
                />
              </div>
            )}
        </RecordTabs>
      )}
    </section>
  );
}
