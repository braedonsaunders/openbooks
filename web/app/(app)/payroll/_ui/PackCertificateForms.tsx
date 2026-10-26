"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@openbooks/ui";
import { readApiErrorMessage } from "../../../../lib/api-error";
import { promptDialog } from "../../../../lib/prompt";
import { MoneyInput, moneyFieldError } from "../../../../components/money-input";
import { DateField } from "../../../../components/date-field";

/**
 * Pack-declared certificate answers — the entry surface for every row-backed
 * withholding form any payroll pack declares (the NL opgaaf and SV facts,
 * the DE ELStAM, the FR PAS option).
 *
 * Everything renders from the declarations served by
 * GET /api/payroll/certificates: no country, form number or field key is
 * named in this file. Field kinds map to inputs (choice → select,
 * count → number, amount → decimal text, flag → checkbox, code → text);
 * saves validate server-side against the same declarations. Column-backed
 * certificates are edited in the payroll profile, never here.
 */

export interface DeclaredCertificateField {
  key: string;
  label: string;
  kind: "choice" | "count" | "amount" | "flag" | "code";
  choices?: readonly { value: string; label: string; help?: string }[];
  decimals?: number;
  min?: string;
  max?: string;
  default?: string;
  required?: boolean;
  help: string;
}

export interface DeclaredRowCertificate {
  key: string;
  form: string;
  label: string;
  scope: { level: string; region?: string; subRegion?: string };
  citation: string;
  summary: string;
  fields: readonly DeclaredCertificateField[];
}

export interface StoredCertificateRow {
  id?: string;
  certificate_key: string;
  country: string;
  region: string | null;
  sub_region: string | null;
  answers: Record<string, string>;
  effective_from: string | null;
  superseded_on: string | null;
  created_at?: string | null;
  created_by_name?: string | null;
  updated_at?: string | null;
  updated_by_name?: string | null;
}

/** The latest row in force per certificate key (current first, then history). */
export function latestCertificateRow(
  stored: readonly StoredCertificateRow[],
  key: string,
): StoredCertificateRow | null {
  const rows = stored
    .filter((row) => row.certificate_key === key)
    .sort((a, b) => (a.effective_from ?? "").localeCompare(b.effective_from ?? ""));
  return rows.find((row) => row.superseded_on === null) ?? rows[rows.length - 1] ?? null;
}

function FieldInput(props: {
  field: DeclaredCertificateField;
  value: string;
  onChange: (value: string) => void;
}) {
  const { field, value, onChange } = props;
  const id = `cert-${field.key}`;
  if (field.kind === "flag") {
    return (
      <label htmlFor={id} className="flex items-center gap-2 text-sm">
        <input
          id={id}
          type="checkbox"
          checked={value === "true"}
          onChange={(event) => onChange(event.target.checked ? "true" : "false")}
        />
        <span>
          {field.label}
          {field.required ? " *" : ""}
        </span>
      </label>
    );
  }
  if (field.kind === "choice") {
    return (
      <label htmlFor={id} className="block text-sm">
        <span className="mb-1 block font-medium">
          {field.label}
          {field.required ? " *" : ""}
        </span>
        <select
          id={id}
          className="w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-600 dark:bg-slate-800"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">—</option>
          {(field.choices ?? []).map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (field.kind === "count") {
    return (
      <label htmlFor={id} className="block text-sm">
        <span className="mb-1 block font-medium">
          {field.label}
          {field.required ? " *" : ""}
        </span>
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={field.min}
          max={field.max}
          className="w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-600 dark:bg-slate-800"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    );
  }
  if (field.kind === "amount") {
    return (
      <label htmlFor={id} className="block text-sm">
        <span className="mb-1 block font-medium">
          {field.label}
          {field.required ? " *" : ""}
        </span>
        <MoneyInput
          id={id}
          ariaLabel={field.label}
          value={value}
          onChange={onChange}
          field={field.label}
          noun="a money amount"
          maxScale={4}
          placeholder={field.default ?? ""}
          className="w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-600 dark:bg-slate-800"
        />
      </label>
    );
  }
  return (
    <label htmlFor={id} className="block text-sm">
      <span className="mb-1 block font-medium">
        {field.label}
        {field.required ? " *" : ""}
      </span>
      <input
        id={id}
        type="text"
        inputMode="text"
        placeholder={field.default ?? ""}
        className="w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-600 dark:bg-slate-800"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function CertificateForm(props: {
  partyId: string;
  country: string;
  certificate: DeclaredRowCertificate;
  stored: readonly StoredCertificateRow[];
  /** Hire date the effective-date input defaults to — never a silent today. */
  employmentStart?: string | null;
  /** Org business day, the fallback default when no hire date is known. */
  today?: string | null;
  onSaved?: () => void;
  /** Values only: no inputs, no save. The employee drawer read mode. */
  readOnly?: boolean;
  /**
   * Unsaved-draft signal for embedding drawers (the employee drawer's close
   * guard). The parent remounts this form whenever the underlying row
   * changes, so the mount-time draft is the baseline and a save clears the
   * signal through the remount — no manual reset here.
   */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const {
    partyId,
    country,
    certificate,
    stored,
    employmentStart,
    today,
    onSaved,
    readOnly,
    onDirtyChange,
  } = props;
  const tc = useTranslations("common");
  const tp = useTranslations("payroll.profiles.certificates");
  // The parent remounts this form (via `key`) whenever the underlying row
  // changes, so the draft below is always seeded from the latest answers and
  // no effect has to sync props into state.
  const row = latestCertificateRow(stored, certificate.key);
  const [answers, setAnswers] = useState<Record<string, string>>(
    Object.fromEntries(
      certificate.fields.map((field) => [field.key, row?.answers[field.key] ?? ""]),
    ),
  );
  // An explicit effective date on every filing, defaulting to the employment
  // start so a converting org files history as of when it began — never a
  // silent server-side today the operator never saw.
  const [effectiveFrom, setEffectiveFrom] = useState(
    row?.effective_from ?? employmentStart ?? today ?? "",
  );
  const [busy, setBusy] = useState(false);
  // The last server refusal, rendered inline under the form (besides the
  // toast) so a 422 names its remedy where the operator files.
  const [refusal, setRefusal] = useState<string | null>(null);

  // Unsaved-draft signal (see onDirtyChange): the mount-time draft is the
  // baseline because the parent remounts on every underlying row change.
  const snapshot = JSON.stringify([answers, effectiveFrom]);
  const [baseline] = useState(snapshot);
  const reportedRef = useRef<boolean | null>(null);
  useEffect(() => {
    const dirty = snapshot !== baseline;
    if (reportedRef.current !== dirty) {
      reportedRef.current = dirty;
      onDirtyChange?.(dirty);
    }
  });

  // Certificate amounts are classified before the save posts: an unreadable
  // value names its cause and remedy under the field, and the save stays
  // disabled until every amount reads. Blank means unanswered, as before.
  const amountRefusal =
    certificate.fields
      .filter((field) => field.kind === "amount")
      .map((field) => moneyFieldError(field.label, "a money amount", answers[field.key] ?? "", 4))
      .find((refusal) => refusal !== null) ?? null;

  const save = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      const res = await fetch("/api/payroll/certificates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          employeePartyId: partyId,
          country,
          certificateKey: certificate.key,
          answers,
          // Always explicit: the input defaults to the employment start, so
          // a cleared field falls back to that default rather than a silent
          // server-side today.
          effectiveFrom: effectiveFrom || employmentStart || today || null,
        }),
      });
      // The status is checked before the body is parsed: a non-JSON error body
      // must surface the failure, never a SyntaxError from res.json().
      if (!res.ok)
        throw new Error(await readApiErrorMessage(res, "failed to save the certificate"));
      toast.success(tp("saved"));
      onSaved?.();
    } catch (error) {
      const message = (error as Error).message;
      setRefusal(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  const voidFiling = async (filing: StoredCertificateRow) => {
    if (!filing.id) return;
    const reason = await promptDialog({
      title: tp("voidTitle"),
      label: tp("voidReason"),
      multiline: true,
      confirmLabel: tp("voidFiling"),
    });
    if (!reason) return;
    setBusy(true);
    setRefusal(null);
    try {
      const res = await fetch("/api/payroll/certificates", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: filing.id, reason }),
      });
      if (!res.ok)
        throw new Error(await readApiErrorMessage(res, "failed to save the certificate"));
      toast.success(tp("saved"));
      onSaved?.();
    } catch (error) {
      const message = (error as Error).message;
      setRefusal(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  const correctFilingDate = async (filing: StoredCertificateRow, nextDate: string) => {
    if (!filing.id || !nextDate || nextDate === filing.effective_from) return;
    const reason = await promptDialog({
      title: tp("correctionTitle"),
      label: tp("correctionReason"),
      initialValue: "",
      confirmLabel: tp("updateFiling"),
    });
    if (!reason) return;
    setBusy(true);
    setRefusal(null);
    try {
      const res = await fetch("/api/payroll/certificates", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: filing.id, effectiveFrom: nextDate, reason }),
      });
      if (!res.ok)
        throw new Error(await readApiErrorMessage(res, "failed to save the certificate"));
      toast.success(tp("saved"));
      onSaved?.();
    } catch (error) {
      const message = (error as Error).message;
      setRefusal(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  // Read mode serves the latest filing as values: the pack's own labels with
  // the stored answers, the yes/no words from the shared catalog (this file
  // otherwise carries no translations), and no inputs or save button.
  if (readOnly) {
    const latest = latestCertificateRow(stored, certificate.key);
    const display = (field: DeclaredCertificateField): string => {
      const raw = latest?.answers[field.key] ?? "";
      if (field.kind === "flag") return raw === "true" ? tc("labels.yes") : tc("labels.no");
      if (field.kind === "choice") {
        if (!raw) return "—";
        return field.choices?.find((choice) => choice.value === raw)?.label ?? raw;
      }
      return raw === "" ? "—" : raw;
    };
    return (
      <section className="rounded border border-slate-200 p-4 dark:border-slate-700">
        <h4 className="text-sm font-semibold">{certificate.label}</h4>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{certificate.form}</p>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{certificate.summary}</p>
        <div className="mt-3 grid gap-3">
          {certificate.fields.map((field) => (
            <div key={field.key}>
              <p className="block text-sm font-medium">
                {field.label}
                {field.required ? " *" : ""}
              </p>
              <p className="text-sm text-slate-800 dark:text-slate-200">{display(field)}</p>
            </div>
          ))}
          <div>
            <p className="block text-sm font-medium">{tp("effectiveFrom")}</p>
            <p className="text-sm text-slate-800 dark:text-slate-200">
              {latest?.effective_from ?? "—"}
            </p>
          </div>
        </div>
      </section>
    );
  }

  // History, oldest first: every filing on record for this form, so a
  // back-filled earlier certificate and its later successor are both visible
  // with the interval each one governs.
  const history = [...stored]
    .filter((entry) => entry.certificate_key === certificate.key)
    .sort((a, b) => (a.effective_from ?? "").localeCompare(b.effective_from ?? ""));

  return (
    <section className="rounded border border-slate-200 p-4 dark:border-slate-700">
      <h4 className="text-sm font-semibold">{certificate.label}</h4>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{certificate.form}</p>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{certificate.summary}</p>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{tp("saveNote")}</p>
      <div className="mt-3 grid gap-3">
        {certificate.fields.map((field) => (
          <div key={field.key}>
            <FieldInput
              field={field}
              value={answers[field.key] ?? ""}
              onChange={(value) => setAnswers((prev) => ({ ...prev, [field.key]: value }))}
            />
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{field.help}</p>
          </div>
        ))}
        <label htmlFor={`cert-effective-${certificate.key}`} className="block text-sm">
          <span className="mb-1 block font-medium">{tp("effectiveFrom")}</span>
          <DateField
            id={`cert-effective-${certificate.key}`}
            className="rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-600 dark:bg-slate-800"
            value={effectiveFrom}
            onChange={(value) => setEffectiveFrom(value)}
          />
        </label>
      </div>
      {refusal ? (
        <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">
          {refusal}
        </p>
      ) : null}
      <button
        type="button"
        disabled={busy || amountRefusal !== null}
        onClick={save}
        className="mt-3 rounded bg-teal-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? tp("saving") : tp("save")}
      </button>
      {history.length > 0 ? (
        <div className="mt-4 border-t border-slate-200 pt-3 dark:border-slate-700">
          <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {tp("history")}
          </h5>
          <ul className="mt-2 space-y-2">
            {history.map((filing, index) => (
              <FilingHistoryRow
                key={filing.id ?? `${filing.effective_from ?? ""}:${index}`}
                filing={filing}
                busy={busy}
                onVoid={() => voidFiling(filing)}
                onCorrect={(nextDate) => correctFilingDate(filing, nextDate)}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function FilingHistoryRow(props: {
  filing: StoredCertificateRow;
  busy: boolean;
  onVoid: () => void;
  onCorrect: (nextDate: string) => void;
}) {
  const { filing, busy, onVoid, onCorrect } = props;
  const tp = useTranslations("payroll.profiles.certificates");
  const [nextDate, setNextDate] = useState(filing.effective_from ?? "");
  const current = filing.superseded_on === null;
  const filedBy = filing.created_by_name ?? null;
  return (
    <li className="rounded bg-slate-50 p-2 text-xs dark:bg-slate-800">
      <p className="font-medium text-slate-800 dark:text-slate-200">
        {filing.effective_from ?? "—"} → {filing.superseded_on ?? tp("statusCurrent")}
        {!current ? (
          <span className="ml-2 font-normal text-slate-500 dark:text-slate-400">
            ({tp("statusClosed")})
          </span>
        ) : null}
      </p>
      <p className="mt-0.5 text-slate-500 dark:text-slate-400">
        {tp("filedBy")}: {filedBy ?? "—"}
        {filing.created_at ? ` · ${filing.created_at.slice(0, 10)}` : ""}
      </p>
      {filing.id ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1">
            <span className="text-slate-500 dark:text-slate-400">{tp("effectiveFrom")}</span>
            <DateField
              aria-label={tp("effectiveFrom")}
              className="h-8 w-36 rounded border border-slate-300 bg-white px-1 py-0.5 dark:border-slate-600 dark:bg-slate-800"
              value={nextDate}
              onChange={(value) => setNextDate(value)}
            />
          </label>
          <button
            type="button"
            disabled={busy || !nextDate || nextDate === filing.effective_from}
            onClick={() => onCorrect(nextDate)}
            className="rounded border border-slate-300 px-2 py-0.5 font-medium text-slate-700 disabled:opacity-50 dark:border-slate-600 dark:text-slate-200"
          >
            {tp("updateFiling")}
          </button>
          {current ? (
            <button
              type="button"
              disabled={busy}
              onClick={onVoid}
              className="rounded border border-slate-300 px-2 py-0.5 font-medium text-red-700 disabled:opacity-50 dark:border-slate-600 dark:text-red-300"
            >
              {tp("voidFiling")}
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function PackCertificateForms(props: {
  partyId: string;
  country: string;
  readOnly?: boolean;
  /** OR of every certificate draft's unsaved state, for the drawer guard. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const tp = useTranslations("payroll.profiles.certificates");
  const commonActions = useTranslations("common.actions");
  const { partyId, country, readOnly, onDirtyChange } = props;
  const [state, setState] = useState<{
    status: "loading" | "ready" | "error";
    certificates: DeclaredRowCertificate[];
    stored: StoredCertificateRow[];
    employmentStart: string | null;
    today: string | null;
  }>({ status: "loading", certificates: [], stored: [], employmentStart: null, today: null });
  const [version, setVersion] = useState(0);
  const [dirtyFlags, setDirtyFlags] = useState<Record<string, boolean>>({});
  const reportedRef = useRef<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!country) return () => {};
    (async () => {
      try {
        const res = await fetch(`/api/payroll/certificates?employee=${partyId}`);
        // The status is checked before the body is parsed (see above).
        if (!res.ok) throw new Error(await readApiErrorMessage(res, "failed to load certificates"));
        const body = (await res.json()) as {
          declarations?: Record<string, { certificates: DeclaredRowCertificate[] }>;
          stored?: StoredCertificateRow[];
          employmentStart?: string | null;
          today?: string | null;
        };
        if (!cancelled) {
          setState({
            status: "ready",
            certificates: body.declarations?.[country]?.certificates ?? [],
            stored: body.stored ?? [],
            employmentStart: body.employmentStart ?? null,
            today: body.today ?? null,
          });
        }
      } catch (error) {
        if (!cancelled) {
          toast.error((error as Error).message);
          setState({
            status: "error",
            certificates: [],
            stored: [],
            employmentStart: null,
            today: null,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [partyId, country, version]);

  // OR-combine the per-certificate drafts (scoped to the certificates
  // currently declared, so a removed form cannot hold the guard dirty).
  // Reports only on flip; same-value reports are dropped.
  useEffect(() => {
    const dirty = state.certificates.some((certificate) => dirtyFlags[certificate.key] === true);
    if (reportedRef.current !== dirty) {
      reportedRef.current = dirty;
      onDirtyChange?.(dirty);
    }
  });

  if (!country) return null;
  if (state.status === "loading") {
    return <p className="py-4 text-center text-sm text-slate-400">{tp("loading")}</p>;
  }
  if (state.status === "error") {
    return (
      <div
        role="alert"
        className="mt-6 flex flex-wrap items-center gap-2 text-sm text-red-700 dark:text-red-300"
      >
        <span>{tp("loadFailed")}</span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setState({
              status: "loading",
              certificates: [],
              stored: [],
              employmentStart: null,
              today: null,
            });
            setVersion((current) => current + 1);
          }}
        >
          {commonActions("retry")}
        </Button>
      </div>
    );
  }
  if (state.certificates.length === 0) return null;
  return (
    <div className="mt-6 grid gap-4">
      <h3 className="text-sm font-semibold">{tp("title")}</h3>
      {state.certificates.map((certificate) => {
        const rows = state.stored.filter((row) => row.certificate_key === certificate.key);
        // Remount the draft when any underlying filing changes (after a
        // save, void or correction), so the form always seeds from the
        // latest answers with no syncing effect.
        const rowKey = JSON.stringify(
          rows.map((entry) => [
            entry.id ?? "",
            entry.effective_from ?? "",
            entry.superseded_on ?? "",
            entry.answers,
          ]),
        );
        return (
          <CertificateForm
            key={`${certificate.key}:${rowKey}`}
            partyId={partyId}
            country={country}
            certificate={certificate}
            stored={rows}
            employmentStart={state.employmentStart}
            today={state.today}
            readOnly={readOnly}
            onSaved={() => setVersion((v) => v + 1)}
            onDirtyChange={(dirty) =>
              setDirtyFlags((prev) =>
                prev[certificate.key] === dirty ? prev : { ...prev, [certificate.key]: dirty },
              )
            }
          />
        );
      })}
    </div>
  );
}
