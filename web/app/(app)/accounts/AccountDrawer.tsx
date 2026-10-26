"use client";

import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Badge,
  Button,
  Input,
  Label,
  SearchSelect,
  Select,
  Textarea,
  UrlDrawer,
} from "@openbooks/ui";
import {
  CustomFieldInputs,
  type CustomFieldDefClient,
} from "../../../components/custom-field-inputs";
import type { CustomFieldViewer } from "@openbooks/customization";
import type { AccountPayload } from "../../api/accounts/_lib";
import { ReadOnlyValue } from "../../../components/read-only-value";
import { ApiResponseError, apiJson, refusalMessageFromBody } from "../../../lib/api-error";
import { useDirtyClose } from "../../../lib/use-dirty-close";
import { AccountMergePanel } from "./AccountMergePanel";

type Option = { value: string; label: string; type?: string };

/** A save refused because another active account already carries the name. */
interface DuplicateNamePrompt {
  name: string;
  existingAccountId: string;
  existingAccountName: string;
  existingAccountNumber: string | null;
}

type DuplicateNameWarning = {
  code: "duplicate_account_name";
  name: string;
  existingAccountName: string;
  existingAccountNumber: string | null;
};

function duplicateAccountLabel(holder: {
  existingAccountName: string;
  existingAccountNumber: string | null;
}): string {
  return holder.existingAccountNumber
    ? `${holder.existingAccountNumber} ${holder.existingAccountName}`
    : holder.existingAccountName;
}

/** Account merge affordances the server resolves for this drawer. */
export interface AccountDrawerMerge {
  /** Feature on, chart authority, posting authority and unrestricted scope. */
  canMerge: boolean;
  /** Active, postable, unmerged accounts of the same type. */
  targets: { value: string; label: string }[];
  today: string;
  /** An open merge proposal of this account under an Accounting event flow. */
  proposal: {
    changeId: string;
    status: "draft" | "pending" | "approved";
    targetLabel: string;
    effectiveDate: string;
  } | null;
  mergedInto: { label: string; date: string; reason: string | null; href: string } | null;
}

const TYPE_VALUES = [
  "asset_bank",
  "asset_receivable",
  "asset_current_other",
  "asset_fixed",
  "asset_other",
  "liability_payable",
  "liability_card",
  "liability_current_other",
  "liability_long_term",
  "equity",
  "income",
  "income_other",
  "cogs",
  "expense",
  "expense_other",
  "expense_deferred",
  "statistical",
] as const;

const TYPE_KEYS: Record<string, string> = {
  asset_bank: "assetBank",
  asset_receivable: "assetReceivable",
  asset_current_other: "assetCurrentOther",
  asset_fixed: "assetFixed",
  asset_other: "assetOther",
  liability_payable: "liabilityPayable",
  liability_card: "liabilityCard",
  liability_current_other: "liabilityCurrentOther",
  liability_long_term: "liabilityLongTerm",
  equity: "equity",
  income: "income",
  income_other: "incomeOther",
  cogs: "cogs",
  expense: "expense",
  expense_other: "expenseOther",
  expense_deferred: "expenseDeferred",
  statistical: "statistical",
};

const checkboxClass =
  "h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600 dark:bg-slate-950";
const fieldClass = "space-y-1.5";

/** The account row: `accounts` columns as the loader hands them. Column
 *  nullability per schema (`number` is nullable, `monetary` is nullable,
 *  `required_dimensions`/`custom` are JSONB). */
interface AccountRow extends Record<string, unknown> {
  id: string;
  number: string | null;
  name: string;
  type: string;
  description: string | null;
  parent_id: string | null;
  subsidiary_id: string | null;
  is_summary: boolean;
  is_active: boolean;
  currency_restriction: string | null;
  eliminate: boolean;
  reconcilable: boolean;
  required_dimensions: string[];
  custom: Record<string, unknown>;
  subsidiary_include_children: boolean;
  monetary: boolean | null;
}

function isStringMap(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Narrow the loader's untyped account row to the fields this drawer reads.
 *  Loader rows always carry the schema shapes here, so valid payloads pass
 *  through unchanged. */
function asAccountRow(raw: Record<string, unknown>): AccountRow {
  const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
  return {
    ...raw,
    id: text(raw.id) ?? "",
    number: text(raw.number),
    name: text(raw.name) ?? "",
    type: text(raw.type) ?? "",
    description: text(raw.description),
    parent_id: text(raw.parent_id),
    subsidiary_id: text(raw.subsidiary_id),
    is_summary: raw.is_summary === true,
    is_active: raw.is_active === true,
    currency_restriction: text(raw.currency_restriction),
    eliminate: raw.eliminate === true,
    reconcilable: raw.reconcilable === true,
    required_dimensions: Array.isArray(raw.required_dimensions)
      ? raw.required_dimensions.filter((dim): dim is string => typeof dim === "string")
      : [],
    custom: isStringMap(raw.custom) ? raw.custom : {},
    subsidiary_include_children: raw.subsidiary_include_children !== false,
    monetary: typeof raw.monetary === "boolean" ? raw.monetary : null,
  };
}

// The drawer shows the persisted record, never a stale draft: the same
// mapping builds the opening form and reconciles it from a save response.
function toForm(row: AccountRow, create: boolean) {
  return {
    number: row.number ?? "",
    name: row.name ?? "",
    type: row.type ?? "expense",
    description: row.description ?? "",
    parentId: row.parent_id ?? "",
    isSummary: row.is_summary === true,
    isActive: create ? true : row.is_active === true,
    currencyRestriction: row.currency_restriction ?? "",
    eliminate: row.eliminate === true,
    subsidiaryId: row.subsidiary_id ?? "",
    subsidiaryIncludeChildren: row.subsidiary_include_children !== false,
    reconcilable: row.reconcilable === true,
    monetary: typeof row.monetary === "boolean" ? String(row.monetary) : "",
    requiredDimensions: row.required_dimensions,
    custom: row.custom,
  };
}

export function AccountDrawer({
  payload,
  parents,
  currencies,
  subsidiaries,
  fieldDefs,
  customFieldViewer,
  segments,
  canManage,
  closeHref,
  createMode = false,
  multiCurrency = false,
  multiSubsidiary = false,
  baseCurrency = "",
  merge = null,
}: {
  payload: AccountPayload;
  parents: Option[];
  currencies: Option[];
  subsidiaries: Option[];
  fieldDefs: CustomFieldDefClient[];
  /** The viewer's custom-field visibility from the server; omitted shows only open fields. */
  customFieldViewer?: CustomFieldViewer | null;
  segments: { key: string; name: string }[];
  canManage: boolean;
  closeHref: string;
  createMode?: boolean;
  multiCurrency?: boolean;
  /** Org base currency (e.g. USD). In single-currency orgs this is the only
   * settlement currency a reconcilable account can carry. */
  baseCurrency?: string;
  /** Company Settings → Features. Elimination is Multi-subsidiary
   *  consolidation configuration; hide and omit it when that switch is off. */
  multiSubsidiary?: boolean;
  /** Account merges: present while the feature is on; `mergedInto` describes a merged account. */
  merge?: AccountDrawerMerge | null;
}) {
  const t = useTranslations("accounts");
  const tc = useTranslations("common");
  const router = useRouter();
  const fieldId = useId();
  const account = asAccountRow(payload.account);
  const requestIdRef = useRef<string | null>(null);

  const initial = useMemo(() => toForm(account, createMode), [account, createMode]);
  const [form, setForm] = useState(initial);
  const [mode, setMode] = useState<"view" | "edit" | "merge">(createMode ? "edit" : "view");
  const mergedInto = merge?.mergedInto ?? null;
  const canStartMerge = Boolean(
    merge?.canMerge && !mergedInto && !createMode && !account.is_summary,
  );
  // A blocked save that only fires a transient toast reads as "nothing
  // happened" once it dismisses: the
  // failure also persists as a form-level alert, cleared on the next edit.
  // The alert is a node so a duplicate-number refusal can link the account
  // already holding the number; the toast keeps the plain string.
  const [fieldError, setFieldError] = useState<ReactNode>(null);
  // A second active account would share this name. The save is held until the
  // operator picks the existing account or confirms the duplicate.
  const [duplicateName, setDuplicateName] = useState<DuplicateNamePrompt | null>(null);
  const [busy, setBusy] = useState(false);
  const editable = canManage && mode === "edit" && !busy;
  const compatibleParents = parents.filter((option) => option.type === form.type);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setFieldError(null);
    setDuplicateName(null);
    setForm((current) => ({ ...current, [key]: value }));
  };
  // The settlement currency is Multi-currency configuration — except that a
  // reconcilable account MUST carry one (the API 422s without it), so the
  // field stays available whenever the flag is on, even with Multi-currency
  // off. Otherwise single-currency orgs have no UI path to set reconcilable.
  const showCurrencyField = multiCurrency || form.reconcilable;

  function errorMessage(body: { error?: unknown; remedy?: unknown }) {
    const key = typeof body.error === "string" ? body.error : "save_failed";
    if (key === "idempotency-conflict" && typeof body.remedy === "string" && body.remedy.trim()) {
      return body.remedy;
    }
    const known = new Set([
      "name_required",
      "invalid_type",
      "type_has_transactions",
      "invalid_parent",
      "parent_must_be_summary",
      "parent_type_mismatch",
      "parent_cycle",
      "summary_reconcilable_conflict",
      "reconcilable_currency_required",
      "summary_has_transactions",
      "summary_has_children",
      "inactive_has_children",
      "invalid_currency",
      "invalid_subsidiary",
      "invalid_dimensions",
      "invalid_custom_fields",
      "number_in_use",
      "duplicate_account_name",
      "account_changed",
      "invalid_idempotency_key",
      "save_failed",
    ]);
    if (!known.has(key)) {
      // Unmapped refusals read through the shared helper so the server's
      // message, remedy and code render instead of the generic fallback.
      return (
        refusalMessageFromBody(body, { fallback: t("drawer.errors.save_failed") }) ??
        t("drawer.errors.save_failed")
      );
    }
    return t(`drawer.errors.${key}`);
  }

  type DuplicateDetails = {
    existingAccountId?: unknown;
    existingAccountName?: unknown;
    existingAccountNumber?: unknown;
  };

  function duplicateAccountHref(details: DuplicateDetails): string | null {
    const id =
      typeof details.existingAccountId === "string" && details.existingAccountId
        ? details.existingAccountId
        : null;
    if (!id) return null;
    const separator = closeHref.includes("?") ? "&" : "?";
    return `${closeHref}${separator}account=${encodeURIComponent(id)}`;
  }

  function duplicateRefusalAlert(body: { error?: unknown; details?: unknown }): ReactNode {
    const details =
      body.details && typeof body.details === "object" && !Array.isArray(body.details)
        ? (body.details as DuplicateDetails)
        : null;
    const href = details ? duplicateAccountHref(details) : null;
    if (!href) return errorMessage(body);
    const number =
      typeof details!.existingAccountNumber === "string" && details!.existingAccountNumber.trim()
        ? details!.existingAccountNumber.trim()
        : form.number;
    const name =
      typeof details!.existingAccountName === "string" && details!.existingAccountName.trim()
        ? details!.existingAccountName.trim()
        : "";
    return t.rich("drawer.errors.numberInUseBy", {
      number,
      name,
      account: (chunks: ReactNode) => (
        <a className="underline" href={href}>
          {chunks}
        </a>
      ),
    });
  }

  function closeAfterGuard() {
    if (createMode) {
      router.push(closeHref as never);
      return;
    }
    setFieldError(null);
    setForm(initial);
    setMode("view");
  }
  const closeGuard = useDirtyClose({
    dirty: JSON.stringify(form) !== JSON.stringify(initial),
    busy,
    onClose: closeAfterGuard,
    message: tc("feedback.unsavedChanges"),
    confirmLabel: tc("confirm.discardChanges"),
  });

  async function save(options: { acknowledgeDuplicateName?: boolean } = {}) {
    if (!form.name.trim()) {
      toast.error(t("drawer.errors.name_required"));
      return;
    }
    // Refuse client-side what the server would 422: a reconcilable account
    // without a settlement currency. The flag's checkbox defaults the base
    // currency in, so this trips only when no currency can be offered.
    if (form.reconcilable && !form.currencyRestriction) {
      toast.error(t("drawer.errors.reconcilable_currency_required"));
      return;
    }
    setBusy(true);
    if (createMode && !requestIdRef.current) requestIdRef.current = crypto.randomUUID();
    const { currencyRestriction, eliminate, ...formRest } = form;
    try {
      const response = await fetch(createMode ? "/api/accounts" : `/api/accounts/${account.id}`, {
        method: createMode ? "POST" : "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(createMode ? { "Idempotency-Key": requestIdRef.current! } : {}),
        },
        body: JSON.stringify({
          ...formRest,
          number: form.number || null,
          description: form.description || null,
          parentId: form.parentId || null,
          subsidiaryId: form.subsidiaryId || null,
          monetary: form.monetary === "" ? null : form.monetary === "true",
          ...(multiCurrency || form.reconcilable
            ? { currencyRestriction: currencyRestriction || null }
            : {}),
          ...(multiSubsidiary ? { eliminate } : {}),
          ...(options.acknowledgeDuplicateName ? { acknowledgeDuplicateName: true } : {}),
        }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: unknown;
          remedy?: unknown;
          details?: unknown;
        };
        if (data.error === "duplicate_account_name") {
          const details = (
            data.details && typeof data.details === "object" ? data.details : {}
          ) as DuplicateDetails;
          if (typeof details.existingAccountId === "string" && details.existingAccountId) {
            setDuplicateName({
              name: form.name.trim(),
              existingAccountId: details.existingAccountId,
              existingAccountName:
                typeof details.existingAccountName === "string"
                  ? details.existingAccountName.trim()
                  : "",
              existingAccountNumber:
                typeof details.existingAccountNumber === "string" &&
                details.existingAccountNumber.trim()
                  ? details.existingAccountNumber.trim()
                  : null,
            });
            return;
          }
        }
        const message = errorMessage(data);
        // A duplicate number names the account holding it: the pinned alert
        // links it so the operator can open it instead of guessing, while
        // the toast keeps the plain localized string.
        setFieldError(data.error === "number_in_use" ? duplicateRefusalAlert(data) : message);
        toast.error(message);
        return;
      }
      const data = await response.json();
      toast.success(t(createMode ? "drawer.created" : "drawer.saved"));
      // Typing hygiene is advisory: the save stands, and the server's warning
      // (e.g. a bank-typed account with no bank corroboration) surfaces as its
      // own toast so it cannot be mistaken for a failure. Coded warnings
      // resolve through the accounts catalog; anything else shows verbatim.
      const warnings = Array.isArray((data as { warnings?: unknown }).warnings)
        ? (data as { warnings: unknown[] }).warnings
        : [];
      const hygiene = warnings.find(
        (w): w is { code: string; name: string } =>
          typeof w === "object" &&
          w !== null &&
          (w as { code?: unknown }).code === "asset_bank_uncorroborated",
      );
      const duplicate = warnings.find(
        (w): w is DuplicateNameWarning =>
          typeof w === "object" &&
          w !== null &&
          (w as { code?: unknown }).code === "duplicate_account_name",
      );
      const legacy = warnings.find((w): w is string => typeof w === "string");
      setDuplicateName(null);
      if (hygiene) toast.warning(t("hygiene.assetBankUncorroborated", { name: hygiene.name }));
      if (duplicate)
        toast.warning(
          t("hygiene.duplicateAccountName", {
            name: duplicate.name,
            account: duplicateAccountLabel(duplicate),
          }),
        );
      else if (legacy) toast.warning(legacy);
      if (createMode) {
        const createdId = data?.account?.id;
        const separator = closeHref.includes("?") ? "&" : "?";
        router.replace(
          (createdId ? `${closeHref}${separator}account=${createdId}` : closeHref) as never,
        );
        router.refresh();
        return;
      }
      // Show the persisted record, not the draft: the server normalizes
      // (nulls, casing, flags) before it stores.
      if (isStringMap(data.account)) setForm(toForm(asAccountRow(data.account), false));
      setFieldError(null);
      setMode("view");
      router.refresh();
    } catch {
      const message = errorMessage({ error: "save_failed" });
      setFieldError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    void closeGuard.close();
  }

  async function applyApprovedMerge(changeId: string) {
    setBusy(true);
    try {
      await apiJson(
        `/api/accounts/merges/${changeId}/apply`,
        { method: "POST" },
        t("merge.failed"),
      );
      toast.success(t("merge.applied"));
      router.refresh();
    } catch (failure) {
      const message = failure instanceof ApiResponseError ? failure.message : t("merge.failed");
      setFieldError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  function toggleDimension(dimension: string, checked: boolean) {
    set(
      "requiredDimensions",
      checked
        ? [...new Set([...form.requiredDimensions, dimension])]
        : form.requiredDimensions.filter((value) => value !== dimension),
    );
  }

  const value = (content: ReactNode) => (
    <p className="min-h-5 text-sm">
      {content === null || content === undefined || content === "" ? tc("labels.notSet") : content}
    </p>
  );
  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      syncUrlOnClose
      beforeClose={closeGuard.beforeClose}
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span>{createMode ? t("drawer.newTitle") : `${form.number} ${form.name}`.trim()}</span>
          {!createMode ? (
            mergedInto ? (
              <Badge variant="secondary">{t("merge.badge")}</Badge>
            ) : (
              <Badge variant={form.isActive ? "success" : "outline"}>
                {form.isActive ? tc("status.active") : tc("status.inactive")}
              </Badge>
            )
          ) : null}
        </span>
      }
      description={
        createMode
          ? t("drawer.newDescription")
          : mode === "edit"
            ? tc("feedback.editingHint")
            : mode === "merge"
              ? t("merge.title")
              : undefined
      }
      headerActions={
        mode === "edit" ? (
          <>
            <Button variant="outline" disabled={busy} onClick={cancel}>
              {tc("actions.cancel")}
            </Button>
            <Button disabled={busy || !form.name.trim()} onClick={() => void save()}>
              {busy ? tc("actions.saving") : createMode ? t("drawer.create") : tc("actions.save")}
            </Button>
          </>
        ) : mode === "merge" ? undefined : canManage && !mergedInto ? (
          <>
            {canStartMerge ? (
              <Button variant="outline" onClick={() => setMode("merge")}>
                {t("merge.action")}
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => setMode("edit")}>
              {tc("actions.edit")}
            </Button>
          </>
        ) : undefined
      }
    >
      {mode === "merge" && merge ? (
        <AccountMergePanel
          accountId={account.id}
          accountLabel={`${form.number} ${form.name}`.trim()}
          targets={merge.targets}
          today={merge.today}
          onDone={() => setMode("view")}
        />
      ) : (
        <div className="space-y-7 p-1">
          {merge?.proposal && !mergedInto ? (
            <div
              role="status"
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200"
            >
              <span>
                {t(
                  merge.proposal.status === "approved"
                    ? "merge.proposalApproved"
                    : "merge.proposalPending",
                  { target: merge.proposal.targetLabel, date: merge.proposal.effectiveDate },
                )}
              </span>
              {merge.proposal.status === "approved" && merge.canMerge ? (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void applyApprovedMerge(merge.proposal!.changeId)}
                >
                  {t("merge.applyApproved")}
                </Button>
              ) : null}
            </div>
          ) : null}
          {mergedInto ? (
            <div
              role="status"
              className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-800 dark:bg-slate-900/60"
            >
              <p>
                {t.rich("merge.mergedBanner", {
                  target: mergedInto.label,
                  date: mergedInto.date,
                  link: (chunks: ReactNode) => (
                    <a className="underline" href={mergedInto.href}>
                      {chunks}
                    </a>
                  ),
                })}
              </p>
              {mergedInto.reason ? (
                <p className="mt-1 text-slate-600 dark:text-slate-300">
                  {t("merge.mergedReason", { reason: mergedInto.reason })}
                </p>
              ) : null}
            </div>
          ) : null}
          {fieldError ? (
            <p
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 p-2.5 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
            >
              {fieldError}
            </p>
          ) : null}
          {duplicateName ? (
            <div
              role="alert"
              className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
            >
              <p>
                {t("drawer.duplicateName.body", {
                  name: duplicateName.name,
                  account: duplicateAccountLabel(duplicateName),
                })}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    const href = duplicateAccountHref({
                      existingAccountId: duplicateName.existingAccountId,
                    });
                    if (href) router.push(href as never);
                  }}
                >
                  {t("drawer.duplicateName.useExisting")}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void save({ acknowledgeDuplicateName: true })}
                >
                  {t("drawer.duplicateName.createAnyway")}
                </Button>
              </div>
            </div>
          ) : null}
          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className={`${fieldClass} lg:col-span-2`}>
              <Label htmlFor={`${fieldId}-name`}>
                {tc("labels.name")}
                {editable ? <span className="text-red-500"> *</span> : null}
              </Label>
              {editable ? (
                <Input
                  id={`${fieldId}-name`}
                  value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                />
              ) : (
                value(form.name)
              )}
            </div>
            <div className={fieldClass}>
              <Label htmlFor={`${fieldId}-number`}>{tc("labels.number")}</Label>
              {editable ? (
                <Input
                  id={`${fieldId}-number`}
                  className="font-mono"
                  value={form.number}
                  onChange={(e) => set("number", e.target.value)}
                />
              ) : (
                value(<span className="font-mono">{form.number}</span>)
              )}
            </div>
            <div className={fieldClass}>
              <Label htmlFor={`${fieldId}-type`}>{tc("labels.type")}</Label>
              {editable ? (
                <Select
                  id={`${fieldId}-type`}
                  value={form.type}
                  disabled={payload.hasTransactions}
                  onChange={(e) =>
                    setForm((current) => ({ ...current, type: e.target.value, parentId: "" }))
                  }
                >
                  {TYPE_VALUES.map((type) => (
                    <option key={type} value={type}>
                      {t(`types.${TYPE_KEYS[type]}`)}
                    </option>
                  ))}
                </Select>
              ) : (
                value(t(`types.${TYPE_KEYS[form.type]}`))
              )}
              {editable && payload.hasTransactions ? (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {t("drawer.typeLocked")}
                </p>
              ) : null}
            </div>
            <div className={`${fieldClass} sm:col-span-2 lg:col-span-4`}>
              <Label htmlFor={`${fieldId}-description`}>{tc("labels.description")}</Label>
              {editable ? (
                <Textarea
                  id={`${fieldId}-description`}
                  value={form.description}
                  onChange={(e) => set("description", e.target.value)}
                  rows={3}
                />
              ) : (
                value(form.description)
              )}
            </div>
          </section>

          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className={fieldClass}>
              <Label htmlFor={`${fieldId}-parent`}>{t("drawer.parent")}</Label>
              {editable ? (
                <SearchSelect
                  id={`${fieldId}-parent`}
                  value={form.parentId}
                  onChange={(v) => set("parentId", v)}
                  options={compatibleParents}
                  clearable
                  emptyLabel={tc("labels.none")}
                  ariaLabel={t("drawer.parent")}
                />
              ) : (
                value(
                  parents.find((option) => option.value === form.parentId)?.label ??
                    payload.parentName,
                )
              )}
            </div>
            {(editable ? showCurrencyField : multiCurrency || form.currencyRestriction) ? (
              <div className={fieldClass}>
                <Label htmlFor={`${fieldId}-currency-restriction`}>
                  {t("drawer.currencyRestriction")}
                </Label>
                {editable ? (
                  <SearchSelect
                    id={`${fieldId}-currency-restriction`}
                    value={form.currencyRestriction}
                    onChange={(v) => set("currencyRestriction", v)}
                    options={currencies}
                    clearable
                    emptyLabel={t("drawer.anyCurrency")}
                    ariaLabel={t("drawer.currencyRestriction")}
                  />
                ) : (
                  value(form.currencyRestriction || t("drawer.anyCurrency"))
                )}
              </div>
            ) : null}
            <div className={fieldClass}>
              <Label htmlFor={`${fieldId}-monetary`}>{t("drawer.monetary")}</Label>
              {editable ? (
                <SearchSelect
                  id={`${fieldId}-monetary`}
                  value={form.monetary}
                  onChange={(v) => set("monetary", v)}
                  options={[
                    { value: "true", label: t("drawer.monetaryAlways") },
                    { value: "false", label: t("drawer.monetaryNever") },
                  ]}
                  clearable
                  emptyLabel={t("drawer.monetaryDefault")}
                  ariaLabel={t("drawer.monetary")}
                />
              ) : (
                value(
                  form.monetary === "true"
                    ? t("drawer.monetaryAlways")
                    : form.monetary === "false"
                      ? t("drawer.monetaryNever")
                      : t("drawer.monetaryDefault"),
                )
              )}
            </div>
            {subsidiaries.length > 0 ? (
              <div className={fieldClass}>
                <Label htmlFor={`${fieldId}-subsidiary`}>{tc("labels.subsidiary")}</Label>
                {editable ? (
                  <SearchSelect
                    id={`${fieldId}-subsidiary`}
                    value={form.subsidiaryId}
                    onChange={(v) => set("subsidiaryId", v)}
                    options={subsidiaries}
                    clearable
                    emptyLabel={t("drawer.allSubsidiaries")}
                    ariaLabel={tc("labels.subsidiary")}
                  />
                ) : (
                  value(
                    subsidiaries.find((option) => option.value === form.subsidiaryId)?.label ??
                      payload.subsidiaryName ??
                      t("drawer.allSubsidiaries"),
                  )
                )}
              </div>
            ) : null}
          </section>

          {editable ? (
            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => set("isActive", e.target.checked)}
                  className={checkboxClass}
                />
                <span className="text-sm">{tc("labels.active")}</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.isSummary}
                  onChange={(e) =>
                    setForm((current) => ({
                      ...current,
                      isSummary: e.target.checked,
                      reconcilable: e.target.checked ? false : current.reconcilable,
                    }))
                  }
                  className={checkboxClass}
                />
                <span className="text-sm">{t("drawer.summary")}</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.reconcilable}
                  disabled={form.isSummary}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setForm((current) => ({
                      ...current,
                      reconcilable: checked,
                      // Single-currency orgs offer only the base currency: default
                      // it in so checking the flag is immediately savable.
                      currencyRestriction:
                        checked && !current.currencyRestriction && !multiCurrency && baseCurrency
                          ? baseCurrency
                          : current.currencyRestriction,
                    }));
                  }}
                  className={checkboxClass}
                />
                <span className="text-sm">{t("drawer.reconcilable")}</span>
              </label>
              {editable && form.reconcilable && !form.currencyRestriction ? (
                <p className="text-xs text-amber-700 sm:col-span-2 lg:col-span-3 dark:text-amber-400">
                  {t("drawer.errors.reconcilable_currency_required")}
                </p>
              ) : null}
              {multiSubsidiary ? (
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.eliminate}
                    onChange={(e) => set("eliminate", e.target.checked)}
                    className={checkboxClass}
                  />
                  <span className="text-sm">{t("drawer.eliminate")}</span>
                </label>
              ) : null}
              {subsidiaries.length > 0 ? (
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.subsidiaryIncludeChildren}
                    disabled={!form.subsidiaryId}
                    onChange={(e) => set("subsidiaryIncludeChildren", e.target.checked)}
                    className={checkboxClass}
                  />
                  <span className="text-sm">{t("drawer.includeSubsidiaries")}</span>
                </label>
              ) : null}
            </section>
          ) : (
            <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div className={fieldClass}>
                <Label>{tc("labels.active")}</Label>
                <ReadOnlyValue value={form.isActive ? tc("labels.yes") : tc("labels.no")} />
              </div>
              <div className={fieldClass}>
                <Label>{t("drawer.summary")}</Label>
                <ReadOnlyValue value={form.isSummary ? tc("labels.yes") : tc("labels.no")} />
              </div>
              <div className={fieldClass}>
                <Label>{t("drawer.reconcilable")}</Label>
                <ReadOnlyValue value={form.reconcilable ? tc("labels.yes") : tc("labels.no")} />
              </div>
              {multiSubsidiary ? (
                <div className={fieldClass}>
                  <Label>{t("drawer.eliminate")}</Label>
                  <ReadOnlyValue value={form.eliminate ? tc("labels.yes") : tc("labels.no")} />
                </div>
              ) : null}
              {subsidiaries.length > 0 ? (
                <div className={fieldClass}>
                  <Label>{t("drawer.includeSubsidiaries")}</Label>
                  <ReadOnlyValue
                    value={form.subsidiaryIncludeChildren ? tc("labels.yes") : tc("labels.no")}
                  />
                </div>
              ) : null}
            </section>
          )}

          <section className={fieldClass}>
            <Label>{t("drawer.requiredDimensions")}</Label>
            {editable ? (
              <div className="flex flex-wrap gap-x-6 gap-y-3">
                {[...segments, { key: "party", name: t("drawer.dimensions.party") }].map(
                  (dimension) => (
                    <label key={dimension.key} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={form.requiredDimensions.includes(dimension.key)}
                        onChange={(e) => toggleDimension(dimension.key, e.target.checked)}
                        className={checkboxClass}
                      />
                      <span className="text-sm">{dimension.name}</span>
                    </label>
                  ),
                )}
              </div>
            ) : (
              <ReadOnlyValue
                value={[...segments, { key: "party", name: t("drawer.dimensions.party") }]
                  .filter((dimension) => form.requiredDimensions.includes(dimension.key))
                  .map((dimension) => dimension.name)
                  .join(", ")}
              />
            )}
          </section>

          <CustomFieldInputs
            defs={fieldDefs}
            values={form.custom}
            onChange={(v) => set("custom", v)}
            readOnly={!editable}
            viewer={customFieldViewer}
          />
        </div>
      )}
    </UrlDrawer>
  );
}
