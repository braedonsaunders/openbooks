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
import { readApiErrorMessage } from "../../../../lib/api-error";
import type { readOpeningLevySourceContext } from "@openbooks/engine/payroll/opening-levy-source-authority";
import { DateField } from "../../../../components/date-field";

type Context = Awaited<ReturnType<typeof readOpeningLevySourceContext>>;
type Allocation = Context["allocations"][number];
type Draft = {
  programKey: Allocation["programKey"];
  region: string;
  subRegion: string;
  filingAccountId: string | null;
  federalAccountId: string | null;
  amount: string;
};
type Props = {
  employeePartyId: string;
  year: number;
  openingAmounts: Record<string, string>;
  canManage: boolean;
  annualDirty: boolean;
  onSaved: () => void;
};

const CA_PROVINCES = ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"];
const CA_EHT_PROVINCES = ["BC", "MB", "NL", "ON"];
const US_STATES = [
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "DC",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
];

function initialAllocations(context: Context, country: string): Draft[] | null {
  if (context.allocations.length) return context.allocations.map((row) => ({ ...row }));
  if (country === "CA")
    return [
      ...CA_PROVINCES.map((region) => ({
        programKey: "ca_wcb" as const,
        region,
        subRegion: "",
        filingAccountId: null,
        federalAccountId: null,
        amount: "",
      })),
      ...CA_EHT_PROVINCES.map((region) => ({
        programKey: "ca_eht" as const,
        region,
        subRegion: "",
        filingAccountId: null,
        federalAccountId: null,
        amount: "",
      })),
      {
        programKey: "ca_cnt",
        region: "QC",
        subRegion: "",
        filingAccountId: null,
        federalAccountId: null,
        amount: "",
      },
    ];
  if (country !== "US") return country ? [] : null;
  const selectedSui: Context["suiAccounts"] = [];
  for (const id of context.openingSuiAccountIds) {
    const account = context.suiAccounts.find((item) => item.id === id);
    if (account && !selectedSui.some((item) => item.id === id)) selectedSui.push(account);
  }
  const suiRows: Draft[] = selectedSui.map((account) => ({
    programKey: "us_sui" as const,
    region: account.stateCode,
    subRegion: "",
    filingAccountId: account.id,
    federalAccountId: null,
    amount: "",
  }));
  for (const region of context.openingSuiStates)
    if (!suiRows.some((row) => row.region === region)) {
      suiRows.push({
        programKey: "us_sui",
        region,
        subRegion: "",
        filingAccountId: null,
        federalAccountId: null,
        amount: "",
      });
    }
  return [
    {
      programKey: "us_futa",
      region: "US",
      subRegion: "",
      filingAccountId: null,
      federalAccountId: null,
      amount: "",
    },
    ...suiRows,
  ];
}

/** Captures original statutory allocations within the selected employee opening. */
export function OpeningLevySourceForm(props: Props) {
  return <OpeningLevySourceBody key={`${props.employeePartyId}:${props.year}`} {...props} />;
}

function OpeningLevySourceBody({
  employeePartyId,
  year,
  openingAmounts,
  canManage,
  annualDirty,
  onSaved,
}: Props) {
  const t = useTranslations("payroll.openingBalances.levySource");
  const [reload, setReload] = useState(0);
  const [context, setContext] = useState<Context | null>(null);
  const [settledLoadKey, setSettledLoadKey] = useState<string | null>(null);
  const [storedLoadError, setLoadError] = useState("");
  const [reason, setReason] = useState("");
  const [country, setCountry] = useState("");
  const [currency, setCurrency] = useState("");
  const [coverageStart, setCoverageStart] = useState("");
  const [coverageEnd, setCoverageEnd] = useState("");
  const [coverageComplete, setCoverageComplete] = useState(false);
  const [fileId, setFileId] = useState("");
  const [sourceReference, setSourceReference] = useState("");
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const correctionRequest = useRef<{ body: string; id: string } | null>(null);
  const [error, setError] = useState("");
  const dirty = useRef(false);
  const [isDirty, setIsDirty] = useState(false);
  const [draftOpening, setDraftHead] = useState<string | null>(null);
  const mounted = useRef(false);
  const saveController = useRef<AbortController | null>(null);
  const savedCallback = useRef(onSaved);
  useEffect(() => {
    savedCallback.current = onSaved;
  }, [onSaved]);
  const loadFailed = t("loadFailed");
  const identityMismatch = t("identityMismatch");

  const loadKey = JSON.stringify([employeePartyId, year, fileId, reload]);
  const loading = settledLoadKey !== loadKey;
  const loadError = settledLoadKey === loadKey ? storedLoadError : "";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      saveController.current?.abort();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timeout = setTimeout(() => controller.abort(), 15000);
    void (async () => {
      const params = new URLSearchParams({ employeePartyId, taxYear: String(year) });
      if (fileId) params.set("sourceFileId", fileId);
      const response = await fetch("/api/payroll/opening-balances/levy-source?" + params, {
        signal: controller.signal,
      });
      if (!response.ok) throw Error(await readApiErrorMessage(response, loadFailed));
      const next = (await response.json()) as Context;
      if (!active) return;
      if (controller.signal.aborted) throw Error(loadFailed);
      if (
        next.record &&
        (next.record.employeePartyId !== employeePartyId || next.record.taxYear !== year)
      )
        throw Error(identityMismatch);
      setLoadError("");
      setContext(next);
      // A refreshed account/source context must never replace unsaved operator entries.
      if (!dirty.current) {
        setCountry(next.record?.originalCountry ?? "");
        setCurrency(next.record?.originalCurrency ?? "");
        setCoverageStart(next.record?.coverageStart ?? "");
        setCoverageEnd(next.record?.coverageEnd ?? "");
        setCoverageComplete(next.record?.coverageComplete === true);
        setDrafts(initialAllocations(next, next.record?.originalCountry ?? ""));
        setDraftHead(
          next.record
            ? `${next.record.openingBalanceId}:${next.record.openingSha256}:${next.record.openingChildrenSha256}:${next.record.levyAuthorityId ?? ""}:${next.record.allocationSha256 ?? ""}`
            : null,
        );
      }
    })()
      .catch((cause: unknown) => {
        if (active)
          setLoadError(
            cause instanceof Error && cause.name !== "AbortError" ? cause.message : loadFailed,
          );
      })
      .finally(() => {
        clearTimeout(timeout);
        if (active) setSettledLoadKey(loadKey);
      });
    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [employeePartyId, year, fileId, reload, loadFailed, identityMismatch, loadKey]);

  const record = context?.record;
  const sourceReady = !!record?.employerAuthorityId && !!record.subsidiaryId;
  const staleDraft =
    isDirty &&
    draftOpening !==
      (record
        ? `${record.openingBalanceId}:${record.openingSha256}:${record.openingChildrenSha256}:${record.levyAuthorityId ?? ""}:${record.allocationSha256 ?? ""}`
        : null);
  const disabled =
    !canManage ||
    busy ||
    loading ||
    !!loadError ||
    staleDraft ||
    (correcting && !!context?.correctionRefusal);
  const update = (index: number, changes: Partial<Draft>) => {
    dirty.current = true;
    setIsDirty(true);
    setDrafts(
      (rows) =>
        rows?.map((row, rowIndex) => (rowIndex === index ? { ...row, ...changes } : row)) ?? null,
    );
  };
  const addUsRow = (programKey: "us_futa" | "us_sui" | "us_pa_lst") => {
    dirty.current = true;
    setIsDirty(true);
    setDrafts((rows) => [
      ...(rows ?? []),
      {
        programKey,
        region: programKey === "us_pa_lst" ? "PA" : programKey === "us_futa" ? "US" : "",
        subRegion: "",
        filingAccountId: null,
        federalAccountId: null,
        amount: "",
      },
    ]);
  };
  const completeDraft =
    !!context?.source &&
    context.source.id === fileId &&
    !!sourceReference.trim() &&
    !!country &&
    !!currency &&
    !!coverageStart &&
    !!coverageEnd &&
    coverageComplete &&
    drafts !== null &&
    ((country !== "CA" && country !== "US") || drafts.length > 0) &&
    drafts.every(
      (row) =>
        row.amount.trim() !== "" &&
        row.region.length === 2 &&
        (country !== "US" || !!row.federalAccountId) &&
        (row.programKey !== "us_futa" || !!row.filingAccountId) &&
        (row.programKey !== "us_pa_lst" || /^[0-9]{6}$/.test(row.subRegion)),
    );

  async function save() {
    if (
      !record ||
      !sourceReady ||
      (record.levyAuthorityId && !correcting) ||
      (correcting && !!context?.correctionRefusal) ||
      !drafts ||
      disabled ||
      annualDirty ||
      !completeDraft ||
      !reason.trim() ||
      saveController.current
    )
      return;
    const controller = new AbortController();
    saveController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    setBusy(true);
    setError("");
    try {
      const payload = {
        openingBalanceId: record.openingBalanceId,
        expectedOpeningSha256: record.openingSha256,
        expectedOpeningChildrenSha256: record.openingChildrenSha256,
        sourceFileId: context!.source!.id,
        sourceVersionId: context!.source!.versionId,
        sourceSha256: context!.source!.sha256,
        sourceReference,
        originalCountry: country,
        originalCurrency: currency,
        coverageStart,
        coverageEnd,
        coverageComplete,
        allocations: drafts.map((row) => ({ ...row, subRegion: row.subRegion || undefined })),
        reason,
        ...(correcting
          ? {
              expectedAuthorityId: record.levyAuthorityId,
              expectedAllocationSha256: record.allocationSha256,
            }
          : {}),
      };
      if (correcting) {
        const body = JSON.stringify(payload);
        if (correctionRequest.current?.body !== body)
          correctionRequest.current = { body, id: crypto.randomUUID() };
      }
      const response = await fetch("/api/payroll/opening-balances/levy-source", {
        method: correcting ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          ...payload,
          ...(correcting ? { requestId: correctionRequest.current!.id } : {}),
        }),
      });
      if (!response.ok) throw Error(await readApiErrorMessage(response, t("saveFailed")));
      if (!mounted.current) return;
      if (controller.signal.aborted) throw Error(t("saveFailed"));
      dirty.current = false;
      setIsDirty(false);
      setCorrecting(false);
      correctionRequest.current = null;
      setReload((value) => value + 1);
      savedCallback.current();
    } catch (cause: unknown) {
      if (mounted.current)
        setError(
          cause instanceof Error && cause.name !== "AbortError" ? cause.message : t("saveFailed"),
        );
    } finally {
      clearTimeout(timeout);
      saveController.current = null;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <section className="space-y-4" aria-label={t("title")}>
      <p className="text-sm text-slate-500">{t("help")}</p>
      <Alert>
        <AlertDescription>{t("evidenceLimits")}</AlertDescription>
      </Alert>
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
      {!loading && !loadError && context && !record && <p>{t("noOpening")}</p>}
      {record && (
        <dl className="grid gap-2 rounded-lg border border-slate-200 p-3 text-xs sm:grid-cols-2 dark:border-slate-800">
          {(
            [
              ["openingRecord", record.openingBalanceId],
              ["employee", record.employeePartyId],
              ["year", String(record.taxYear)],
              ["employer", record.subsidiaryId],
              ["originalCountry", record.originalCountry],
              ["originalCurrency", record.originalCurrency],
              ["coverageStart", record.coverageStart],
              ["coverageEnd", record.coverageEnd],
              ["reference", record.sourceReference],
              ["sourceFile", record.sourceFileId],
              ["sourceVersion", record.sourceVersionId],
              ["sourceHash", record.sourceSha256],
              ["openingHash", record.openingSha256],
              ...(record.openingChildrenSha256
                ? [["openingChildrenHash", record.openingChildrenSha256]]
                : []),
              ...(record.allocationSha256 ? [["allocationHash", record.allocationSha256]] : []),
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-slate-500">{t(label as never)}</dt>
              <dd className="break-all">{value ?? t("unavailable")}</dd>
            </div>
          ))}
        </dl>
      )}
      {record && !sourceReady && (
        <Alert variant="warning">
          <AlertDescription>{t("qualifyEmployerFirst")}</AlertDescription>
        </Alert>
      )}
      {record?.levyAuthorityId && context && !correcting && (
        <>
          <Alert>
            <AlertDescription>{t("sealed")}</AlertDescription>
          </Alert>

          <Table className="w-full text-sm">
            <TableHeader>
              <TableRow className="text-left">
                <TableHead scope="col" className="p-2">
                  {t("programme")}
                </TableHead>
                <TableHead scope="col" className="p-2">
                  {t("jurisdiction")}
                </TableHead>
                <TableHead scope="col" className="p-2">
                  {t("filingAccount")}
                </TableHead>
                <TableHead scope="col" className="p-2">
                  {t("originalEin")}
                </TableHead>
                <TableHead scope="col" className="p-2 text-right">
                  {t("amount")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {context.allocations.map((row, index) => (
                <TableRow key={index} className="border-t border-slate-100 dark:border-slate-800">
                  <TableCell className="p-2">{t(`programmes.${row.programKey}`)}</TableCell>
                  <TableCell className="p-2">
                    {row.region}
                    {row.subRegion ? ` · ${row.subRegion}` : ""}
                  </TableCell>
                  <TableCell className="p-2">
                    {context.eins.find((ein) => ein.id === row.filingAccountId)?.name ??
                      context.suiAccounts.find((account) => account.id === row.filingAccountId)
                        ?.name ??
                      row.filingAccountId ??
                      "—"}
                  </TableCell>
                  <TableCell className="p-2">
                    {context.eins.find((ein) => ein.id === row.federalAccountId)?.name ??
                      row.federalAccountId ??
                      "—"}
                  </TableCell>
                  <TableCell className="p-2 text-right tabular-nums">{row.amount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-xs text-slate-500">
            {t("reasonLabel")}: {record.levyReason}
          </p>
          {context.correctionRefusal && (
            <Alert variant="warning">
              <AlertDescription>{context.correctionRefusal}</AlertDescription>
            </Alert>
          )}
          {canManage && (
            <Button
              type="button"
              variant="outline"
              disabled={disabled || annualDirty || !!context.correctionRefusal}
              onClick={() => {
                setCorrecting(true);
                setReason("");
                setSourceReference(record.sourceReference ?? "");
                setFileId("");
                correctionRequest.current = null;
                setError("");
              }}
            >
              {t("correctSource")}
            </Button>
          )}
        </>
      )}
      {record && sourceReady && (!record.levyAuthorityId || correcting) && context && (
        <>
          {correcting && (
            <>
              <Alert>
                <AlertDescription>{t("correctionHelp")}</AlertDescription>
              </Alert>
              {context.correctionRefusal && (
                <Alert variant="warning">
                  <AlertDescription>{context.correctionRefusal}</AlertDescription>
                </Alert>
              )}
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setCorrecting(false);
                  dirty.current = false;
                  setIsDirty(false);
                  setReason("");
                  setSourceReference("");
                  setFileId("");
                  correctionRequest.current = null;
                  setError("");
                  setReload((value) => value + 1);
                }}
              >
                {t("cancelCorrection")}
              </Button>
            </>
          )}
          <CabinetFilePicker
            value={fileId}
            label={t("originalReport")}
            disabled={disabled}
            onChange={(value) => {
              dirty.current = true;
              setIsDirty(true);
              setFileId(value);
            }}
          />
          {context.source && (
            <p className="break-all text-xs text-slate-500">
              {context.source.name} · {context.source.versionId} · {context.source.sha256}
            </p>
          )}
          <div>
            <FieldLabel htmlFor="levy-source-reference">{t("reference")}</FieldLabel>
            <Input
              id="levy-source-reference"
              value={sourceReference}
              maxLength={2000}
              disabled={disabled}
              onChange={(event) => {
                dirty.current = true;
                setIsDirty(true);
                setSourceReference(event.target.value);
              }}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <FieldLabel htmlFor="levy-source-country">{t("originalCountry")}</FieldLabel>
              <Select
                id="levy-source-country"
                value={country}
                disabled={disabled}
                onChange={(event) => {
                  dirty.current = true;
                  setIsDirty(true);
                  setCountry(event.target.value);
                  setDrafts(
                    initialAllocations({ ...context, allocations: [] }, event.target.value),
                  );
                }}
              >
                <option value="">{t("chooseCountry")}</option>
                {context.countries.map((option) => (
                  <option key={option.country} value={option.country}>
                    {option.country}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <FieldLabel htmlFor="levy-source-currency">{t("originalCurrency")}</FieldLabel>
              <Select
                id="levy-source-currency"
                value={currency}
                disabled={disabled}
                onChange={(event) => {
                  dirty.current = true;
                  setIsDirty(true);
                  setCurrency(event.target.value);
                }}
              >
                <option value="">{t("chooseCurrency")}</option>
                {[...new Set(context.countries.map((option) => option.currency))].map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <FieldLabel htmlFor="levy-source-coverage-start">{t("coverageStart")}</FieldLabel>
              <DateField
                id="levy-source-coverage-start"
                value={coverageStart}
                disabled={disabled}
                onChange={(value) => {
                  dirty.current = true;
                  setIsDirty(true);
                  setCoverageStart(value);
                }}
              />
            </div>
            <div>
              <FieldLabel htmlFor="levy-source-coverage-end">{t("coverageEnd")}</FieldLabel>
              <DateField
                id="levy-source-coverage-end"
                value={coverageEnd}
                disabled={disabled}
                onChange={(value) => {
                  dirty.current = true;
                  setIsDirty(true);
                  setCoverageEnd(value);
                }}
              />
            </div>
          </div>
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              id="levy-source-complete"
              checked={coverageComplete}
              disabled={disabled}
              onChange={(event) => {
                dirty.current = true;
                setIsDirty(true);
                setCoverageComplete(event.target.checked);
              }}
            />
            {t("coverageComplete")}
          </label>
          {drafts && (
            <>
              {annualDirty && (
                <Alert variant="warning">
                  <AlertDescription>{t("saveFirst")}</AlertDescription>
                </Alert>
              )}
              {staleDraft && (
                <Alert variant="warning">
                  <AlertDescription>{t("staleDraft")}</AlertDescription>
                </Alert>
              )}
              {staleDraft && canManage && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || loading}
                  onClick={() => {
                    dirty.current = false;
                    setIsDirty(false);
                    setReason("");
                    setError("");
                    setReload((value) => value + 1);
                  }}
                >
                  {t("discardAndReload")}
                </Button>
              )}
              {country === "CA" && (
                <p className="text-xs text-slate-500">
                  {t("caTotals")} {t("wcbTotal")}:{" "}
                  {openingAmounts.wcbAssessableYtd ?? t("unavailable")} · {t("ehtTotal")}:{" "}
                  {openingAmounts.ehtRemunerationYtd ?? t("unavailable")}
                </p>
              )}
              {country === "US" && <p className="text-xs text-slate-500">{t("usAccounts")}</p>}
              {country === "US" && !context.eins.length && (
                <Alert variant="warning">
                  <AlertDescription>{t("restoreEin")}</AlertDescription>
                </Alert>
              )}
              <div className="space-y-3">
                {drafts.map((row, index) => {
                  const regionOptions =
                    row.programKey === "ca_wcb"
                      ? CA_PROVINCES
                      : row.programKey === "ca_eht"
                        ? CA_EHT_PROVINCES
                        : row.programKey === "ca_cnt"
                          ? ["QC"]
                          : row.programKey === "us_sui"
                            ? US_STATES
                            : row.programKey === "us_pa_lst"
                              ? ["PA"]
                              : ["US"];
                  const accountOptions =
                    row.programKey === "us_futa"
                      ? context.eins
                      : row.programKey === "us_sui"
                        ? context.suiAccounts.filter((account) => account.stateCode === row.region)
                        : [];
                  const showAccount =
                    row.programKey === "us_futa" ||
                    (row.programKey === "us_sui" && accountOptions.length > 0);
                  const fieldId = (field: string) => `levy-source-${index}-${field}`;
                  return (
                    <div
                      key={index}
                      className="grid gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-6 dark:border-slate-800"
                    >
                      <div>
                        <FieldLabel htmlFor={fieldId("programme")}>{t("programme")}</FieldLabel>
                        <Select
                          id={fieldId("programme")}
                          value={row.programKey}
                          disabled={disabled || country === "CA"}
                          onChange={(event) => {
                            const programKey = event.target.value as Draft["programKey"];
                            update(index, {
                              programKey,
                              region:
                                programKey === "us_pa_lst"
                                  ? "PA"
                                  : programKey === "us_futa"
                                    ? "US"
                                    : "",
                              subRegion: "",
                              filingAccountId: null,
                              federalAccountId: null,
                            });
                          }}
                        >
                          {(country === "CA"
                            ? (["ca_wcb", "ca_eht", "ca_cnt"] as const)
                            : (["us_futa", "us_sui", "us_pa_lst"] as const)
                          ).map((key) => (
                            <option key={key} value={key}>
                              {t(`programmes.${key}`)}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div>
                        <FieldLabel htmlFor={fieldId("region")}>{t("jurisdiction")}</FieldLabel>
                        <Select
                          id={fieldId("region")}
                          value={row.region}
                          disabled={
                            disabled ||
                            country === "CA" ||
                            row.programKey === "us_futa" ||
                            row.programKey === "us_pa_lst"
                          }
                          onChange={(event) => {
                            update(index, {
                              region: event.target.value,
                              filingAccountId: null,
                              federalAccountId: null,
                            });
                          }}
                        >
                          <option value="">{t("chooseJurisdiction")}</option>
                          {regionOptions.map((code) => (
                            <option key={code} value={code}>
                              {code}
                            </option>
                          ))}
                        </Select>
                      </div>
                      {row.programKey === "us_pa_lst" && (
                        <div>
                          <FieldLabel htmlFor={fieldId("psd")}>{t("psd")}</FieldLabel>
                          <Input
                            id={fieldId("psd")}
                            value={row.subRegion}
                            maxLength={6}
                            inputMode="numeric"
                            disabled={disabled}
                            onChange={(event) => update(index, { subRegion: event.target.value })}
                          />
                        </div>
                      )}
                      <div>
                        {showAccount && (
                          <>
                            <FieldLabel htmlFor={fieldId("account")}>
                              {t(row.programKey === "us_futa" ? "ein" : "suiAccount")}
                            </FieldLabel>
                            <Select
                              id={fieldId("account")}
                              value={row.filingAccountId ?? ""}
                              disabled={disabled}
                              onChange={(event) =>
                                update(index, {
                                  filingAccountId: event.target.value || null,
                                  ...(row.programKey === "us_futa"
                                    ? { federalAccountId: event.target.value || null }
                                    : {}),
                                })
                              }
                            >
                              <option value="">
                                {t(row.programKey === "us_futa" ? "chooseEin" : "chooseSuiAccount")}
                              </option>
                              {accountOptions.map((account) => (
                                <option key={account.id} value={account.id}>
                                  {account.name}
                                  {!account.isActive ? ` · ${t("inactiveAccount")}` : ""}
                                </option>
                              ))}
                            </Select>
                          </>
                        )}
                        <FieldLabel
                          htmlFor={fieldId("amount")}
                          className={showAccount ? "mt-2" : undefined}
                        >
                          {t("amount")}
                        </FieldLabel>
                        <Input
                          id={fieldId("amount")}
                          value={row.amount}
                          inputMode="decimal"
                          disabled={disabled}
                          onChange={(event) => update(index, { amount: event.target.value })}
                        />
                      </div>
                      {country === "US" && row.programKey !== "us_futa" && (
                        <div>
                          <FieldLabel htmlFor={fieldId("federal-account")}>
                            {t("originalEin")}
                          </FieldLabel>
                          <Select
                            id={fieldId("federal-account")}
                            value={row.federalAccountId ?? ""}
                            disabled={disabled}
                            onChange={(event) =>
                              update(index, { federalAccountId: event.target.value || null })
                            }
                          >
                            <option value="">{t("chooseEin")}</option>
                            {context.eins.map((account) => (
                              <option key={account.id} value={account.id}>
                                {account.name}
                                {!account.isActive ? ` · ${t("inactiveAccount")}` : ""}
                              </option>
                            ))}
                          </Select>
                        </div>
                      )}
                      <div className="flex items-end">
                        {country === "US" && (
                          <Button
                            type="button"
                            variant="outline"
                            disabled={disabled}
                            onClick={() => {
                              dirty.current = true;
                              setIsDirty(true);
                              setDrafts(
                                (rows) => rows?.filter((_, rowIndex) => rowIndex !== index) ?? null,
                              );
                            }}
                          >
                            {t("remove")}
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {country === "US" && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={disabled}
                    onClick={() => addUsRow("us_futa")}
                  >
                    {t("addFuta")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={disabled}
                    onClick={() => addUsRow("us_sui")}
                  >
                    {t("addSui")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={disabled}
                    onClick={() => addUsRow("us_pa_lst")}
                  >
                    {t("addLst")}
                  </Button>
                </div>
              )}
              <div>
                <FieldLabel htmlFor="levy-source-reason">{t("reasonLabel")}</FieldLabel>
                <Input
                  id="levy-source-reason"
                  value={reason}
                  maxLength={2000}
                  disabled={disabled}
                  onChange={(event) => {
                    dirty.current = true;
                    setIsDirty(true);
                    setReason(event.target.value);
                  }}
                />
              </div>
              {error && (
                <Alert variant="warning">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              {canManage && (
                <Button
                  type="button"
                  onClick={() => void save()}
                  disabled={disabled || annualDirty || !completeDraft || !reason.trim()}
                >
                  {busy ? t("saving") : t(correcting ? "replaceCertificate" : "qualify")}
                </Button>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
