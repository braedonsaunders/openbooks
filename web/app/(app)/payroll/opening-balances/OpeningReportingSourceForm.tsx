"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Alert,
  AlertDescription,
  Button,
  FieldLabel,
  Input,
  Select,
  Skeleton,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@openbooks/ui";
import { CabinetFilePicker } from "../../../../components/cabinet-file-picker";
import { RecordTabs } from "../../../../components/module-home/record-tabs";
import { readApiErrorMessage } from "../../../../lib/api-error";
import type { readCanadianOpeningReportingSourceContext } from "@openbooks/engine/payroll/canada/opening-reporting-authority";
import type { CanadianOpeningReportingAllocation } from "@openbooks/engine/payroll/canada/opening-reporting-source";
import { canonicalNonNegativeDecimal, isZeroDecimal } from "@openbooks/engine/money/decimal";
import { DateField } from "../../../../components/date-field";

type Context = Awaited<ReturnType<typeof readCanadianOpeningReportingSourceContext>>;
type Draft = Omit<CanadianOpeningReportingAllocation, "sourceOrdinal"> & { sourceOrdinal: string };
type AmountSection =
  "annual" | "reportableBases" | "components" | "programBases" | "accountBases" | "suiStates";
type Props = {
  employeePartyId: string;
  year: number;
  canQualify: boolean;
  annualDirty: boolean;
  active: boolean;
  fields: { column?: string; label: string }[];
  components: { componentId: string; name: string }[];
  programs: { key: string; label: string }[];
  onSaved: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
};
const PROVINCES = [
  "AB",
  "BC",
  "MB",
  "NB",
  "NL",
  "NS",
  "NT",
  "NU",
  "ON",
  "PE",
  "QC",
  "SK",
  "YT",
  "ZZ",
];

function head(context: Context) {
  const original = context.original;
  return [
    original.openingBalanceId,
    original.authorityId,
    original.levyAllocationSha256,
    original.openingSha256,
    original.openingChildrenSha256,
  ].join(":");
}

function certifiedZero(value: unknown): string {
  const exact = canonicalNonNegativeDecimal(value, 4);
  return exact !== null && isZeroDecimal(exact) ? "0.0000" : "";
}

/** Non-negative allocations of an exact certified zero must each remain zero. */
function blankAllocation(context: Context): Draft {
  const children = context.original.children!;
  const qpipRows = children.programBases.filter((row) => row.program_key === "qpip");
  return {
    sourceOrdinal: "",
    firstCoveredPayDate: "",
    filingAccountId: "",
    province: "",
    reportableBases: {
      ei: certifiedZero(context.original.annualAmounts.insurable_ytd),
      cpp: certifiedZero(context.original.annualAmounts.pensionable_ytd),
      // The complete certified child list establishes the aggregate without selecting a province or cap.
      qpip: qpipRows.every((row) => certifiedZero(row.insurable_ytd) !== "") ? "0.0000" : "",
    },
    annualAmounts: Object.fromEntries(
      Object.entries(context.original.annualAmounts).map(([key, value]) => [
        key,
        certifiedZero(value),
      ]),
    ),
    children: {
      components: children.components.map((row) => ({
        ...row,
        ytd_amount: certifiedZero(row.ytd_amount),
      })),
      programBases: children.programBases.map((row) => ({
        ...row,
        insurable_ytd: certifiedZero(row.insurable_ytd),
      })),
      accountBases: children.accountBases.map((row) => ({
        ...row,
        insurable_ytd: certifiedZero(row.insurable_ytd),
      })),
      suiStates: children.suiStates.map((row) => ({
        ...row,
        insurable_ytd: certifiedZero(row.insurable_ytd),
      })),
    },
  };
}

export function OpeningReportingSourceForm(props: Props) {
  return <OpeningReportingSourceBody key={`${props.employeePartyId}:${props.year}`} {...props} />;
}

function OpeningReportingSourceBody({
  employeePartyId,
  year,
  canQualify,
  annualDirty,
  active,
  fields,
  components,
  programs,
  onSaved,
  onDirtyChange,
  onBusyChange,
}: Props) {
  const t = useTranslations("payroll.openingBalances.reportingSource");
  const [context, setContext] = useState<Context | null>(null);
  const [settledLoadKey, setSettledLoadKey] = useState<string | null>(null);
  const [storedLoadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [selected, setSelected] = useState(0);
  const [section, setSection] = useState<AmountSection>("annual");
  const [fileId, setFileId] = useState("");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty = useRef(false);
  const [isDirty, setIsDirty] = useState(false);
  const [draftHead, setDraftHead] = useState<string | null>(null);
  const request = useRef<{ body: string; id: string } | null>(null);
  const mounted = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const callbacks = useRef({ onSaved, onDirtyChange, onBusyChange });
  useEffect(() => {
    callbacks.current = { onSaved, onDirtyChange, onBusyChange };
  }, [onSaved, onDirtyChange, onBusyChange]);
  const loadFailed = t("loadFailed");
  const mismatch = t("identityMismatch");
  const [visited, setVisited] = useState(active);
  if (active && !visited) setVisited(true);
  const loadKey = JSON.stringify([employeePartyId, year, fileId, reload, visited]);
  const loading = settledLoadKey !== loadKey;
  const loadError = settledLoadKey === loadKey ? storedLoadError : "";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      callbacks.current.onBusyChange(false);
      callbacks.current.onDirtyChange(false);
    };
  }, []);
  useEffect(() => {
    if (!visited) return;
    const abort = new AbortController();
    let live = true;
    const timeout = setTimeout(() => abort.abort(), 15000);
    void (async () => {
      const params = new URLSearchParams({ employeePartyId, taxYear: String(year) });
      if (fileId) params.set("sourceFileId", fileId);
      const response = await fetch("/api/payroll/opening-balances/reporting-source?" + params, {
        signal: abort.signal,
      });
      if (!response.ok) throw Error(await readApiErrorMessage(response, loadFailed));
      const next = (await response.json()) as Context;
      if (!live) return;
      if (abort.signal.aborted) throw Error(loadFailed);
      if (
        !next.original.children ||
        next.original.employeePartyId !== employeePartyId ||
        next.original.taxYear !== year ||
        (next.reporting &&
          (next.reporting.employeePartyId !== employeePartyId || next.reporting.taxYear !== year))
      )
        throw Error(mismatch);
      setLoadError("");
      setContext(next);
      if (!dirty.current) {
        setDrafts(
          next.allocations.map((row) => ({ ...row, sourceOrdinal: String(row.sourceOrdinal) })),
        );
        setDraftHead(head(next));
        setSelected(0);
      }
    })()
      .catch((cause: unknown) => {
        if (live)
          setLoadError(
            cause instanceof Error && cause.name !== "AbortError" ? cause.message : loadFailed,
          );
      })
      .finally(() => {
        clearTimeout(timeout);
        if (live) setSettledLoadKey(loadKey);
      });
    return () => {
      live = false;
      clearTimeout(timeout);
      abort.abort();
    };
  }, [employeePartyId, year, fileId, reload, visited, loadFailed, mismatch, loadKey]);

  function markDirty() {
    dirty.current = true;
    setIsDirty(true);
    callbacks.current.onDirtyChange(true);
  }
  const stale = !!context && isDirty && draftHead !== head(context);
  const sealed = !!context?.reporting;
  const disabled = !canQualify || busy || loading || !!loadError || stale || sealed;
  const allocation = drafts[selected];
  function accountLabel(id: string) {
    const account = context?.filingAccounts.find((row) => row.id === id);
    return account
      ? [account.name, account.accountNumber, account.id].filter(Boolean).join(" · ")
      : id;
  }
  function update(changes: Partial<Draft>) {
    markDirty();
    setDrafts((rows) =>
      rows.map((row, index) => (index === selected ? { ...row, ...changes } : row)),
    );
  }
  function changeChild(
    family: Exclude<AmountSection, "annual" | "reportableBases">,
    index: number,
    value: string,
  ) {
    if (!allocation) return;
    const children = { ...allocation.children };
    if (family === "components")
      children.components = children.components.map((row, rowIndex) =>
        rowIndex === index ? { ...row, ytd_amount: value } : row,
      );
    if (family === "programBases")
      children.programBases = children.programBases.map((row, rowIndex) =>
        rowIndex === index ? { ...row, insurable_ytd: value } : row,
      );
    if (family === "accountBases")
      children.accountBases = children.accountBases.map((row, rowIndex) =>
        rowIndex === index ? { ...row, insurable_ytd: value } : row,
      );
    if (family === "suiStates")
      children.suiStates = children.suiStates.map((row, rowIndex) =>
        rowIndex === index ? { ...row, insurable_ytd: value } : row,
      );
    update({ children });
  }
  const complete =
    drafts.length > 0 &&
    drafts.every(
      (row) =>
        /^\d+$/.test(row.sourceOrdinal) &&
        Number.isSafeInteger(Number(row.sourceOrdinal)) &&
        Number(row.sourceOrdinal) > 0 &&
        Number(row.sourceOrdinal) <= 2147483647 &&
        !!row.firstCoveredPayDate &&
        !!row.filingAccountId &&
        !!row.province &&
        Object.values(row.annualAmounts).every((value) => !!value.trim()) &&
        Object.values(row.reportableBases).every((value) => !!value.trim()) &&
        row.children.components.every((child) => !!child.ytd_amount.trim()) &&
        [
          ...row.children.programBases,
          ...row.children.accountBases,
          ...row.children.suiStates,
        ].every((child) => !!child.insurable_ytd.trim()),
    );

  async function save() {
    if (
      !context ||
      disabled ||
      annualDirty ||
      !complete ||
      !reason.trim() ||
      !reference.trim() ||
      !context.selectedSource ||
      context.selectedSource.id !== fileId ||
      controller.current
    )
      return;
    const abort = new AbortController();
    controller.current = abort;
    const timeout = setTimeout(() => abort.abort(), 15000);
    setBusy(true);
    callbacks.current.onBusyChange(true);
    setError("");
    try {
      const original = context.original;
      const payload = {
        openingBalanceId: original.openingBalanceId,
        expectedLevyAuthorityId: original.authorityId,
        expectedLevyAllocationSha256: original.levyAllocationSha256,
        expectedOpeningSha256: original.openingSha256,
        expectedOpeningChildrenSha256: original.openingChildrenSha256,
        sourceFileId: context.selectedSource.id,
        sourceVersionId: context.selectedSource.versionId,
        sourceSha256: context.selectedSource.sha256,
        sourceReference: reference,
        reason,
        allocations: drafts.map((row) => ({ ...row, sourceOrdinal: Number(row.sourceOrdinal) })),
      };
      const body = JSON.stringify(payload);
      if (request.current?.body !== body) request.current = { body, id: crypto.randomUUID() };
      const response = await fetch("/api/payroll/opening-balances/reporting-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abort.signal,
        body: JSON.stringify({ ...payload, requestId: request.current.id }),
      });
      if (!response.ok) throw Error(await readApiErrorMessage(response, t("saveFailed")));
      if (!mounted.current) return;
      if (abort.signal.aborted) throw Error(t("saveFailed"));
      dirty.current = false;
      setIsDirty(false);
      callbacks.current.onDirtyChange(false);
      request.current = null;
      setReload((value) => value + 1);
      callbacks.current.onSaved();
    } catch (cause: unknown) {
      if (mounted.current)
        setError(
          cause instanceof Error && cause.name !== "AbortError" ? cause.message : t("saveFailed"),
        );
    } finally {
      clearTimeout(timeout);
      controller.current = null;
      if (mounted.current) {
        setBusy(false);
        callbacks.current.onBusyChange(false);
      }
    }
  }

  function amountRows(): {
    key: string;
    label: string;
    original: string;
    value: string;
    index?: number;
  }[] {
    if (!context || !allocation) return [];
    const original = context.original;
    if (section === "annual")
      return Object.entries(original.annualAmounts).map(([column, amount]) => ({
        key: column,
        label: fields.find((field) => field.column === column)?.label ?? column,
        original: amount,
        value: allocation.annualAmounts[column]!,
      }));
    if (section === "reportableBases")
      return (["ei", "cpp", "qpip"] as const).map((key) => ({
        key,
        label: t(`bases.${key}`),
        original: "—",
        value: allocation.reportableBases[key],
      }));
    if (section === "components")
      return original.children!.components.map((row) => {
        const index = allocation.children.components.findIndex(
          (child) => child.component_id === row.component_id,
        );
        return {
          key: row.component_id,
          label:
            components.find((component) => component.componentId === row.component_id)?.name ??
            row.component_id,
          original: row.ytd_amount,
          value: allocation.children.components[index]?.ytd_amount ?? "",
          index,
        };
      });
    if (section === "programBases")
      return original.children!.programBases.map((row) => {
        const index = allocation.children.programBases.findIndex(
          (child) => child.program_key === row.program_key,
        );
        return {
          key: row.program_key,
          label:
            programs.find((program) => program.key === row.program_key)?.label ?? row.program_key,
          original: row.insurable_ytd,
          value: allocation.children.programBases[index]?.insurable_ytd ?? "",
          index,
        };
      });
    if (section === "accountBases")
      return original.children!.accountBases.map((row) => {
        const index = allocation.children.accountBases.findIndex(
          (child) =>
            child.program_key === row.program_key &&
            child.filing_account_id === row.filing_account_id &&
            child.region === row.region,
        );
        return {
          key: JSON.stringify([row.program_key, row.filing_account_id, row.region]),
          label: `${programs.find((program) => program.key === row.program_key)?.label ?? row.program_key} · ${row.filing_account_id} · ${row.region ?? "—"}`,
          original: row.insurable_ytd,
          value: allocation.children.accountBases[index]?.insurable_ytd ?? "",
          index,
        };
      });
    return original.children!.suiStates.map((row) => {
      const index = allocation.children.suiStates.findIndex((child) => child.state === row.state);
      return {
        key: row.state,
        label: row.state,
        original: row.insurable_ytd,
        value: allocation.children.suiStates[index]?.insurable_ytd ?? "",
        index,
      };
    });
  }

  function changeAmount(key: string, index: number | undefined, value: string) {
    if (!allocation) return;
    if (section === "annual")
      update({ annualAmounts: { ...allocation.annualAmounts, [key]: value } });
    else if (section === "reportableBases")
      update({ reportableBases: { ...allocation.reportableBases, [key]: value } });
    else if (index !== undefined) changeChild(section, index, value);
  }

  return (
    <section className="space-y-4" aria-label={t("title")}>
      <p className="text-sm text-slate-500">{t("help")}</p>
      {loading && <Skeleton className="h-24 w-full" />}
      {loadError && (
        <Alert variant="warning">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}
      {!loading && (
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => setReload((value) => value + 1)}
        >
          {t(loadError ? "retry" : "reload")}
        </Button>
      )}
      {context && (
        <>
          <dl className="grid gap-2 rounded-lg border border-slate-200 p-3 text-xs sm:grid-cols-2 dark:border-slate-800">
            {(
              [
                ["opening", context.original.openingBalanceId],
                ["employer", context.original.subsidiaryId],
                ["levyCertificate", context.original.authorityId],
                ["levyHash", context.original.levyAllocationSha256],
                ["openingHash", context.original.openingSha256],
                ["childrenHash", context.original.openingChildrenSha256],
                ["levySourceFile", context.original.sourceFileId],
                ["levySourceVersion", context.original.sourceVersionId],
                ["levySourceHash", context.original.sourceSha256],
                ["levyReference", context.original.sourceReference],
                ["coverage", `${context.original.coverageStart} – ${context.original.coverageEnd}`],
                ...(context.reporting
                  ? [
                      ["sourceFile", context.reporting.sourceFileId],
                      ["sourceVersion", context.reporting.sourceVersionId],
                      ["sourceHash", context.reporting.sourceSha256],
                      ["reference", context.reporting.sourceReference],
                      ["allocationHash", context.reporting.allocationSha256],
                    ]
                  : []),
              ] as [string, string][]
            ).map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-slate-500">{t(label as never)}</dt>
                <dd className="break-all">{value}</dd>
              </div>
            ))}
          </dl>
          {sealed ? (
            <Alert>
              <AlertDescription>
                {t("sealed")} {t("correctionRemedy")}
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <Alert>
                <AlertDescription>{t("evidence")}</AlertDescription>
              </Alert>
              {!context.filingAccounts.length && (
                <Alert variant="warning">
                  <AlertDescription>{t("restoreRp")}</AlertDescription>
                </Alert>
              )}
              <CabinetFilePicker
                value={fileId}
                label={t("originalReport")}
                disabled={!canQualify || busy || loading}
                onChange={(value) => {
                  markDirty();
                  setFileId(value);
                }}
              />
              {context.selectedSource && (
                <p className="break-all text-xs text-slate-500">
                  {context.selectedSource.name} · {context.selectedSource.versionId} ·{" "}
                  {context.selectedSource.sha256}
                </p>
              )}
              <div>
                <FieldLabel htmlFor="reporting-source-reference">{t("reference")}</FieldLabel>
                <Input
                  id="reporting-source-reference"
                  value={reference}
                  maxLength={2000}
                  disabled={disabled}
                  onChange={(event) => {
                    markDirty();
                    setReference(event.target.value);
                  }}
                />
              </div>
            </>
          )}
          {stale && (
            <Alert variant="warning">
              <AlertDescription>{t("staleDraft")}</AlertDescription>
            </Alert>
          )}
          {stale && (
            <Button
              type="button"
              variant="outline"
              disabled={busy || loading}
              onClick={() => {
                dirty.current = false;
                setIsDirty(false);
                callbacks.current.onDirtyChange(false);
                request.current = null;
                setReference("");
                setReason("");
                setFileId("");
                setError("");
                setReload((value) => value + 1);
              }}
            >
              {t("discardAndReload")}
            </Button>
          )}
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1">
              <FieldLabel htmlFor="reporting-source-allocation">{t("allocation")}</FieldLabel>
              <Select
                id="reporting-source-allocation"
                value={drafts.length ? String(selected) : ""}
                disabled={!drafts.length || busy}
                onChange={(event) => setSelected(Number(event.target.value))}
              >
                {!drafts.length && <option value="">{t("noAllocations")}</option>}
                {drafts.map((row, index) => (
                  <option key={index} value={index}>
                    {t("slice", { number: index + 1 })} ·{" "}
                    {row.filingAccountId ? accountLabel(row.filingAccountId) : "—"} ·{" "}
                    {row.province || "—"}
                  </option>
                ))}
              </Select>
            </div>
            {!sealed && canQualify && (
              <Button
                type="button"
                variant="outline"
                disabled={disabled}
                onClick={() => {
                  markDirty();
                  setDrafts((rows) => [...rows, blankAllocation(context)]);
                  setSelected(drafts.length);
                }}
              >
                {t("add")}
              </Button>
            )}
            {!sealed && allocation && canQualify && (
              <Button
                type="button"
                variant="outline"
                disabled={disabled}
                onClick={() => {
                  markDirty();
                  setDrafts((rows) => rows.filter((_, index) => index !== selected));
                  setSelected(0);
                }}
              >
                {t("remove")}
              </Button>
            )}
          </div>
          {allocation && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <FieldLabel htmlFor="reporting-source-rp">{t("rp")}</FieldLabel>
                  <Select
                    id="reporting-source-rp"
                    value={allocation.filingAccountId}
                    disabled={disabled}
                    onChange={(event) => update({ filingAccountId: event.target.value })}
                  >
                    <option value="">{t("chooseRp")}</option>
                    {context.filingAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {accountLabel(account.id)}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <FieldLabel htmlFor="reporting-source-province">{t("province")}</FieldLabel>
                  <Select
                    id="reporting-source-province"
                    value={allocation.province}
                    disabled={disabled}
                    onChange={(event) => update({ province: event.target.value })}
                  >
                    <option value="">{t("chooseProvince")}</option>
                    {PROVINCES.map((province) => (
                      <option key={province} value={province}>
                        {province}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <FieldLabel htmlFor="reporting-source-ordinal">{t("ordinal")}</FieldLabel>
                  <Input
                    id="reporting-source-ordinal"
                    value={allocation.sourceOrdinal}
                    inputMode="numeric"
                    disabled={disabled}
                    onChange={(event) => update({ sourceOrdinal: event.target.value })}
                  />
                </div>
                <div>
                  <FieldLabel htmlFor="reporting-source-first-pay">{t("firstPay")}</FieldLabel>
                  <DateField
                    id="reporting-source-first-pay"
                    min={context.original.coverageStart}
                    max={context.original.coverageEnd}
                    value={allocation.firstCoveredPayDate}
                    disabled={disabled}
                    onChange={(value) => update({ firstCoveredPayDate: value })}
                  />
                </div>
              </div>
              <RecordTabs
                label={t("amountSections")}
                active={section}
                onChange={setSection}
                tabs={(
                  [
                    "annual",
                    "reportableBases",
                    "components",
                    "programBases",
                    "accountBases",
                    "suiStates",
                  ] as const
                ).map((key) => ({ key, label: t(key) }))}
              />
              {section === "reportableBases" && (
                <p className="text-sm text-slate-500">{t("reportableHelp")}</p>
              )}
              <Table className="w-full text-sm">
                <TableHeader>
                  <TableRow className="text-left">
                    <TableHead scope="col" className="p-2">
                      {t("field")}
                    </TableHead>
                    <TableHead scope="col" className="p-2 text-right">
                      {t("originalAmount")}
                    </TableHead>
                    <TableHead scope="col" className="p-2">
                      {t("allocatedAmount")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {amountRows().map((row, index) => (
                    <TableRow
                      key={row.key}
                      className="border-t border-slate-100 dark:border-slate-800"
                    >
                      <TableHead scope="row" className="p-2 text-left font-normal">
                        {row.label}
                      </TableHead>
                      <TableCell className="p-2 text-right tabular-nums">{row.original}</TableCell>
                      <TableCell className="p-2">
                        {sealed ? (
                          <span className="tabular-nums">{row.value}</span>
                        ) : (
                          <Input
                            id={`reporting-source-${section}-${index}`}
                            aria-label={`${row.label}: ${t("allocatedAmount")}`}
                            value={row.value}
                            inputMode="decimal"
                            disabled={disabled}
                            onChange={(event) =>
                              changeAmount(row.key, row.index, event.target.value)
                            }
                          />
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {amountRows().length === 0 && (
                <p className="p-3 text-sm text-slate-500">{t("noChildren")}</p>
              )}
            </>
          )}
          {!sealed && (
            <>
              {annualDirty && (
                <Alert variant="warning">
                  <AlertDescription>{t("saveFirst")}</AlertDescription>
                </Alert>
              )}
              <div>
                <FieldLabel htmlFor="reporting-source-reason">{t("reason")}</FieldLabel>
                <Input
                  id="reporting-source-reason"
                  value={reason}
                  maxLength={2000}
                  disabled={disabled}
                  onChange={(event) => {
                    markDirty();
                    setReason(event.target.value);
                  }}
                />
              </div>
              {error && (
                <Alert variant="warning">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              {canQualify && (
                <Button
                  type="button"
                  disabled={
                    disabled ||
                    annualDirty ||
                    !complete ||
                    !reason.trim() ||
                    !reference.trim() ||
                    context.selectedSource?.id !== fileId
                  }
                  onClick={() => void save()}
                >
                  {t(busy ? "saving" : "qualify")}
                </Button>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
