"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, FieldLabel, Input, SearchSelect, Select } from "@openbooks/ui";
import { useMoney } from "@/components/money-provider";
import { add } from "@openbooks/engine/money";
import {
  CASH_TENDER_KINDS,
  expectedTenderedForCloseout,
} from "@openbooks/engine/sales/cash-tenders";
import { canonicalDecimal, compareDecimal, isZeroDecimal } from "@/lib/exact-decimal";

export interface TenderDraft {
  kind: string;
  methodLabel?: string;
  accountId: string;
  storedValueAccountId?: string;
  /** Last four of the resolved code, display only — never saved. */
  svLast4?: string;
  /** Resolved balance in document currency, display only — never saved. */
  svBalance?: string;
  amount: string;
  /** Card tip collected inside this tender for staff — posts to the
   *  tips-payable liability, never revenue. Saved on the sale's close-out. */
  tipAmount?: string;
  /** Processor fee withheld from this tender's settlement — posts to the
   *  fee expense so deposits reconcile net. Saved on the sale's close-out. */
  feeAmount?: string;
  reference?: string;
  externalRef?: string;
}

/** Daily close-out facts beside the tenders: the counted cash over/short
 *  (positive over, negative short) and the server the tips belong to (null
 *  pools them for the house split). Totals derive from the tender tips and
 *  fees on save, so the two can never drift. */
export interface CloseoutDraft {
  overShort: string;
  /** Staff the tips belong to; null pools them for the house split. An
   *  explicit null clears a previously named server on save, while an
   *  absent key keeps the stored one. */
  serverPartyId?: string | null;
}

const CARD_FAMILY_KINDS = ["card", "bank_transfer", "wallet", "gateway"] as const;

export interface TenderAccountOption {
  value: string;
  label: string;
}

export interface StoredValueResolution {
  accountId: string;
  balance: string;
  currency: string;
  last4: string;
  status: string;
}

const GATEWAY_LIKE_KINDS = ["bank_transfer", "wallet", "gateway"] as const;

function pickString(entry: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

export function parseTenderDrafts(raw: unknown): TenderDraft[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (entry): entry is Record<string, unknown> =>
        !!entry && typeof entry === "object" && !Array.isArray(entry),
    )
    .map((entry) => ({
      kind: pickString(entry, "kind") || "cash",
      ...(pickString(entry, "methodLabel", "method_label")
        ? { methodLabel: pickString(entry, "methodLabel", "method_label") }
        : {}),
      accountId: pickString(entry, "accountId", "account_id"),
      ...(pickString(entry, "storedValueAccountId", "stored_value_account_id")
        ? {
            storedValueAccountId: pickString(
              entry,
              "storedValueAccountId",
              "stored_value_account_id",
            ),
          }
        : {}),
      ...(pickString(entry, "svLast4") ? { svLast4: pickString(entry, "svLast4") } : {}),
      ...(pickString(entry, "svBalance") ? { svBalance: pickString(entry, "svBalance") } : {}),
      amount: pickString(entry, "amount"),
      ...(pickString(entry, "tipAmount", "tip_amount")
        ? { tipAmount: pickString(entry, "tipAmount", "tip_amount") }
        : {}),
      ...(pickString(entry, "feeAmount", "fee_amount")
        ? { feeAmount: pickString(entry, "feeAmount", "fee_amount") }
        : {}),
      ...(pickString(entry, "reference") ? { reference: pickString(entry, "reference") } : {}),
      ...(pickString(entry, "externalRef", "external_ref")
        ? { externalRef: pickString(entry, "externalRef", "external_ref") }
        : {}),
    }));
}

/** Parse the close-out facts beside the tenders. Unknown shapes pool. */
export function parseCloseoutDraft(raw: unknown): CloseoutDraft {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { overShort: "" };
  const entry = raw as Record<string, unknown>;
  const overShort = typeof entry.overShort === "string" ? entry.overShort : "";
  const serverPartyId =
    typeof entry.serverPartyId === "string" && entry.serverPartyId.length > 0
      ? entry.serverPartyId
      : undefined;
  return { overShort, ...(serverPartyId ? { serverPartyId } : {}) };
}

/**
 * Fold a stored close-out's per-tender parts back into tender drafts by
 * position. Tender rows persist only the gross collected amounts — tips and
 * fees ride the sale's close-out — so a reload that seeds the editor from
 * the table alone would show blank tips, misstate the balance, and wipe the
 * stored close-out on the next save. Parts fill only blank tip/fee fields,
 * so an in-progress edit always wins over storage.
 */
export function mergeCloseoutPartsIntoTenders(tenders: unknown, closeout: unknown): unknown {
  if (!Array.isArray(tenders)) return tenders;
  const bag =
    closeout && typeof closeout === "object" && !Array.isArray(closeout)
      ? (closeout as Record<string, unknown>)
      : null;
  const parts = Array.isArray(bag?.parts) ? (bag.parts as unknown[]) : [];
  if (parts.length === 0) return tenders;
  const byPosition = new Map<number, { tip?: string; fee?: string }>();
  for (const part of parts) {
    if (!part || typeof part !== "object" || Array.isArray(part)) continue;
    const row = part as Record<string, unknown>;
    if (typeof row.position !== "number" || !Number.isInteger(row.position)) continue;
    byPosition.set(row.position, {
      ...(typeof row.tip === "string" && row.tip !== "" ? { tip: row.tip } : {}),
      ...(typeof row.fee === "string" && row.fee !== "" ? { fee: row.fee } : {}),
    });
  }
  if (byPosition.size === 0) return tenders;
  return tenders.map((entry, index) => {
    const part = byPosition.get(index + 1);
    if (!part) return entry;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const row = entry as Record<string, unknown>;
    // Table rows and drafts share the writer's camelCase shape; a field the
    // draft already names stays untouched so an edit always wins.
    const merged: Record<string, unknown> = { ...row };
    if (part.tip !== undefined && typeof row.tipAmount !== "string") merged.tipAmount = part.tip;
    if (part.fee !== undefined && typeof row.feeAmount !== "string") merged.feeAmount = part.fee;
    return merged;
  });
}

/**
 * Paid-at-sale settlement editor. Tenders name how each part of the total
 * settled: a clearing or bank account, or a gift card / store credit
 * resolved by code with its live balance shown before Save. The section
 * cross-foots tendered against the document total live, so an undertendered
 * sale is visible before Save — and the kernel refuses it by name at
 * posting regardless. Read-only once posted: the journal owns history
 * from there.
 */
export function CashTendersSection({
  value,
  onChange,
  editable,
  total,
  currency,
  accountOptions,
  defaultAccountId,
  storedValueEnabled,
  resolveStoredValueCode,
  closeoutValue,
  onCloseoutChange,
  serverOptions,
  tillSuggestion,
}: {
  value: unknown;
  onChange: (next: TenderDraft[]) => void;
  editable: boolean;
  total: string;
  currency: string;
  accountOptions: TenderAccountOption[];
  defaultAccountId?: string | null;
  storedValueEnabled?: boolean;
  resolveStoredValueCode?: (code: string) => Promise<StoredValueResolution | null>;
  /** Close-out facts beside the tenders; the editor renders only when
   *  onCloseoutChange is provided. Totals always derive from tender tips
   *  and fees on save. */
  closeoutValue?: unknown;
  onCloseoutChange?: (next: CloseoutDraft) => void;
  /** Staff the tips belong to; empty pools them for the house split. */
  serverOptions?: TenderAccountOption[];
  /** The till window this sale closes (it is the window's last sale), when
   *  a drop has closed it: dropped minus tendered cash, offered as the
   *  close-out over/short for the operator to confirm. */
  tillSuggestion?: {
    difference: string;
    after: string | null;
    through: string;
    tillAccountId: string;
  } | null;
}) {
  const t = useTranslations("ar");
  const { money } = useMoney();
  const tenders = useMemo(() => parseTenderDrafts(value), [value]);
  const visibleKinds = useMemo(
    () =>
      (CASH_TENDER_KINDS as readonly string[]).filter(
        (kind) => kind !== "stored_value" || storedValueEnabled,
      ),
    [storedValueEnabled],
  );
  const kindOptions = visibleKinds.map((kind) => ({
    value: kind,
    label: t(`tenders.kinds.${kind}`),
  }));
  const [codeInputs, setCodeInputs] = useState<Record<number, string>>({});
  const [codeErrors, setCodeErrors] = useState<Record<number, string>>({});
  const [checking, setChecking] = useState<Record<number, boolean>>({});

  // Exact decimal-string cross-foot: entries that are not valid decimals are
  // skipped here and refused by name on save, never coerced or rounded.
  // With a close-out the till collects total + tips − fees ± over/short, so
  // the expected side restates explicitly instead of pretending exact match.
  const closeout = useMemo(() => parseCloseoutDraft(closeoutValue), [closeoutValue]);
  // A recorded close-out shows its over/short and server read-only even when
  // the drawer is not editable, so a posted or viewed sale states what the
  // till counted and who the tips belong to.
  const closeoutRecorded = closeout.overShort !== "" || closeout.serverPartyId !== undefined;
  const tendered = useMemo(() => {
    let sum = "0";
    for (const tender of tenders) {
      if (typeof tender.amount !== "string") continue;
      const exact = canonicalDecimal(tender.amount, 4);
      if (exact === null) continue;
      sum = add(sum, exact);
    }
    return sum;
  }, [tenders]);
  const closeoutTotals = useMemo(() => {
    let tips = "0";
    let fees = "0";
    for (const tender of tenders) {
      const tip =
        typeof tender.tipAmount === "string" && tender.tipAmount !== ""
          ? canonicalDecimal(tender.tipAmount, 4)
          : "0";
      const fee =
        typeof tender.feeAmount === "string" && tender.feeAmount !== ""
          ? canonicalDecimal(tender.feeAmount, 4)
          : "0";
      if (tip !== null) tips = add(tips, tip);
      if (fee !== null) fees = add(fees, fee);
    }
    return { tips, fees };
  }, [tenders]);
  const expected = useMemo(() => {
    try {
      // One derivation with the posting kernel
      // (expectedTenderedForCloseout): adding nothing when a leg is blank
      // states the same total as skipping it.
      const overShort = closeout.overShort !== "" ? canonicalDecimal(closeout.overShort, 4) : "0";
      return expectedTenderedForCloseout(
        total || "0",
        closeoutTotals.tips,
        closeoutTotals.fees,
        overShort ?? "0",
      );
    } catch {
      return total || "0";
    }
  }, [total, closeoutTotals, closeout]);

  const comparison = useMemo(() => {
    try {
      return compareDecimal(tendered, expected);
    } catch {
      return 0;
    }
  }, [tendered, expected]);

  const update = (index: number, patch: Partial<TenderDraft>) => {
    onChange(tenders.map((tender, i) => (i === index ? { ...tender, ...patch } : tender)));
  };
  const addTender = () => {
    onChange([...tenders, { kind: "cash", accountId: defaultAccountId ?? "", amount: "" }]);
  };
  const remove = (index: number) => {
    onChange(tenders.filter((_, i) => i !== index));
  };
  const checkCode = async (index: number) => {
    const code = (codeInputs[index] ?? "").trim();
    if (!code || !resolveStoredValueCode) return;
    setChecking((c) => ({ ...c, [index]: true }));
    setCodeErrors((c) => ({ ...c, [index]: "" }));
    try {
      const resolved = await resolveStoredValueCode(code);
      if (!resolved) {
        setCodeErrors((c) => ({ ...c, [index]: t("tenders.codeNotFound") }));
        return;
      }
      update(index, {
        storedValueAccountId: resolved.accountId,
        svLast4: resolved.last4,
        svBalance: resolved.balance,
      });
    } finally {
      setChecking((c) => ({ ...c, [index]: false }));
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <FieldLabel fieldName={t("tenders.title")}>{t("tenders.title")}</FieldLabel>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {t("tenders.tenderedOf", {
            tendered: money(tendered, { currency }),
            total: money(expected, { currency }),
          })}
        </span>
        {tenders.length > 0 ? (
          <Badge variant={comparison === 0 ? "success" : "warning"}>
            {comparison === 0 ? t("tenders.balanced") : t("tenders.unbalanced")}
          </Badge>
        ) : null}
      </div>
      {editable ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">{t("tenders.help")}</p>
      ) : null}
      {/* Tax is figured on each sale line and added up — the drawer states
          the policy where the cashier cross-foots, so a one-cent gap to tax
          figured on the day's total reads as policy, not error. */}
      <p className="text-xs text-slate-500 dark:text-slate-400">{t("tenders.taxHint")}</p>
      {tenders.map((tender, index) => {
        const isStoredValue = tender.kind === "stored_value";
        const isCardFamily = (CARD_FAMILY_KINDS as readonly string[]).includes(tender.kind);
        return (
          <div key={index} className="space-y-1">
            <div className="grid grid-cols-[110px_1fr_1fr_130px_1fr_auto] items-end gap-2">
              <div>
                <FieldLabel fieldName={t("tenders.method")}>{t("tenders.method")}</FieldLabel>
                {editable ? (
                  <Select
                    value={tender.kind}
                    onChange={(e) =>
                      update(index, {
                        kind: e.target.value,
                        ...(e.target.value === "stored_value"
                          ? { accountId: "", tipAmount: undefined, feeAmount: undefined }
                          : {
                              storedValueAccountId: undefined,
                              svLast4: undefined,
                              svBalance: undefined,
                              ...((CARD_FAMILY_KINDS as readonly string[]).includes(e.target.value)
                                ? {}
                                : { feeAmount: undefined }),
                            }),
                      })
                    }
                  >
                    {kindOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <p className="text-sm">
                    {kindOptions.find((o) => o.value === tender.kind)?.label ?? tender.kind}
                  </p>
                )}
              </div>
              <div>
                <FieldLabel fieldName={t("tenders.label")}>{t("tenders.label")}</FieldLabel>
                {editable ? (
                  <Input
                    value={tender.methodLabel ?? ""}
                    onChange={(e) => update(index, { methodLabel: e.target.value })}
                    placeholder={
                      kindOptions.find((o) => o.value === tender.kind)?.label ?? tender.kind
                    }
                  />
                ) : (
                  <p className="text-sm">
                    {tender.methodLabel ||
                      kindOptions.find((o) => o.value === tender.kind)?.label ||
                      tender.kind}
                  </p>
                )}
              </div>
              <div>
                <FieldLabel fieldName={isStoredValue ? t("tenders.code") : t("tenders.account")}>
                  {isStoredValue ? t("tenders.code") : t("tenders.account")}
                </FieldLabel>
                {isStoredValue ? (
                  editable ? (
                    <div className="space-y-1">
                      <div className="flex gap-1">
                        <Input
                          value={
                            tender.storedValueAccountId
                              ? `…${tender.svLast4 ?? ""}`
                              : (codeInputs[index] ?? "")
                          }
                          onChange={(e) => {
                            setCodeInputs((c) => ({ ...c, [index]: e.target.value }));
                            if (tender.storedValueAccountId) {
                              update(index, {
                                storedValueAccountId: undefined,
                                svLast4: undefined,
                                svBalance: undefined,
                              });
                            }
                          }}
                          placeholder={t("tenders.codePlaceholder")}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={checking[index] || !(codeInputs[index] ?? "").trim()}
                          onClick={() => void checkCode(index)}
                        >
                          {t("tenders.checkBalance")}
                        </Button>
                      </div>
                      {tender.svBalance ? (
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          {t("tenders.balance", { balance: money(tender.svBalance, { currency }) })}
                        </p>
                      ) : null}
                      {codeErrors[index] ? (
                        <p className="text-xs text-amber-700 dark:text-amber-300">
                          {codeErrors[index]}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="text-sm">{tender.svLast4 ? `…${tender.svLast4}` : "—"}</p>
                  )
                ) : editable ? (
                  <SearchSelect
                    options={accountOptions}
                    value={tender.accountId}
                    onChange={(v) => update(index, { accountId: v ?? "" })}
                    placeholder={t("tenders.accountPlaceholder")}
                  />
                ) : (
                  <p className="text-sm">
                    {accountOptions.find((o) => o.value === tender.accountId)?.label ??
                      tender.accountId}
                  </p>
                )}
              </div>
              <div>
                <FieldLabel fieldName={t("tenders.amount")}>{t("tenders.amount")}</FieldLabel>
                {editable ? (
                  <Input
                    inputMode="decimal"
                    value={tender.amount}
                    onChange={(e) => update(index, { amount: e.target.value })}
                    placeholder="0.00"
                  />
                ) : (
                  <p className="text-sm tabular-nums">
                    {money(tender.amount || "0", { currency })}
                  </p>
                )}
              </div>
              <div>
                <FieldLabel fieldName={t("tenders.reference")}>{t("tenders.reference")}</FieldLabel>
                {editable ? (
                  <div className="space-y-1">
                    <Input
                      value={tender.reference ?? ""}
                      onChange={(e) => update(index, { reference: e.target.value })}
                      placeholder={t("tenders.referencePlaceholder")}
                    />
                    {(GATEWAY_LIKE_KINDS as readonly string[]).includes(tender.kind) ? (
                      <Input
                        value={tender.externalRef ?? ""}
                        onChange={(e) => update(index, { externalRef: e.target.value })}
                        placeholder={t("tenders.externalRefPlaceholder")}
                      />
                    ) : null}
                  </div>
                ) : (
                  <p className="text-sm">{tender.reference ?? "—"}</p>
                )}
              </div>
              {editable ? (
                <Button type="button" variant="outline" size="sm" onClick={() => remove(index)}>
                  {t("tenders.remove")}
                </Button>
              ) : null}
            </div>
            {!isStoredValue ? (
              <div className="grid grid-cols-[110px_130px_130px_1fr] items-end gap-2 pl-1">
                <p className="pb-2 text-xs text-slate-500 dark:text-slate-400">
                  {t("tenders.closeout")}
                </p>
                <div>
                  <FieldLabel fieldName={t("tenders.tip")}>{t("tenders.tip")}</FieldLabel>
                  {editable ? (
                    <Input
                      inputMode="decimal"
                      value={tender.tipAmount ?? ""}
                      onChange={(e) => update(index, { tipAmount: e.target.value })}
                      placeholder="0.00"
                    />
                  ) : (
                    <p className="text-sm tabular-nums">
                      {tender.tipAmount ? money(tender.tipAmount, { currency }) : "—"}
                    </p>
                  )}
                </div>
                {isCardFamily ? (
                  <div>
                    <FieldLabel fieldName={t("tenders.fee")}>{t("tenders.fee")}</FieldLabel>
                    {editable ? (
                      <Input
                        inputMode="decimal"
                        value={tender.feeAmount ?? ""}
                        onChange={(e) => update(index, { feeAmount: e.target.value })}
                        placeholder="0.00"
                      />
                    ) : (
                      <p className="text-sm tabular-nums">
                        {tender.feeAmount ? money(tender.feeAmount, { currency }) : "—"}
                      </p>
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
      {editable ? (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={addTender}>
            {t("tenders.add")}
          </Button>
          {tenders.length === 0 && !isZeroDecimal(total || "0") ? (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
              {t("tenders.emptyHint")}
            </p>
          ) : null}
        </div>
      ) : null}
      {onCloseoutChange || closeoutRecorded ? (
        <div className="space-y-1 border-t border-slate-200 pt-2 dark:border-slate-700">
          <FieldLabel fieldName={t("tenders.overShort")}>{t("tenders.overShort")}</FieldLabel>
          <div className="grid grid-cols-[130px_1fr] items-end gap-2">
            <div>
              {editable && onCloseoutChange ? (
                <Input
                  inputMode="decimal"
                  value={closeout.overShort}
                  onChange={(e) => onCloseoutChange({ ...closeout, overShort: e.target.value })}
                  placeholder="0.00"
                />
              ) : (
                <p className="text-sm tabular-nums">
                  {closeout.overShort !== "" ? money(closeout.overShort, { currency }) : "—"}
                </p>
              )}
            </div>
            <div>
              <FieldLabel fieldName={t("tenders.server")}>{t("tenders.server")}</FieldLabel>
              {editable && onCloseoutChange ? (
                serverOptions && serverOptions.length > 0 ? (
                  <SearchSelect
                    options={serverOptions}
                    value={closeout.serverPartyId ?? ""}
                    onChange={(v) =>
                      onCloseoutChange({ ...closeout, serverPartyId: v === "" ? null : v })
                    }
                    placeholder={t("tenders.serverPooled")}
                    clearable
                    emptyLabel={t("tenders.serverPooled")}
                  />
                ) : (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {t("tenders.serverPooled")}
                  </p>
                )
              ) : (
                <p className="text-sm">
                  {closeout.serverPartyId
                    ? (serverOptions?.find((o) => o.value === closeout.serverPartyId)?.label ??
                      closeout.serverPartyId)
                    : t("tenders.serverPooled")}
                </p>
              )}
            </div>
          </div>
          {editable && onCloseoutChange ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t("tenders.overShortHint")}
            </p>
          ) : null}
          {editable &&
          onCloseoutChange &&
          tillSuggestion &&
          !isZeroDecimal(tillSuggestion.difference) ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50/70 px-2 py-1.5 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-200">
              <span>
                {t(
                  tillSuggestion.after ? "tenders.tillDifference" : "tenders.tillDifferenceFirst",
                  {
                    after: tillSuggestion.after ?? "",
                    through: tillSuggestion.through,
                    difference: money(tillSuggestion.difference, { currency }),
                  },
                )}
              </span>
              {editable && onCloseoutChange ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    // The count is the till's cash: raise this sale's cash
                    // tender to the till by the window difference and carry
                    // the same amount as over/short, so the sale cross-foots.
                    const index = tenders.findIndex(
                      (tender) =>
                        tender.kind === "cash" && tender.accountId === tillSuggestion.tillAccountId,
                    );
                    if (index < 0) return;
                    const current = canonicalDecimal(tenders[index]!.amount ?? "0", 4) ?? "0";
                    onChange(
                      tenders.map((tender, i) =>
                        i === index
                          ? { ...tender, amount: add(current, tillSuggestion.difference) }
                          : tender,
                      ),
                    );
                    const priorOverShort =
                      closeout.overShort !== ""
                        ? (canonicalDecimal(closeout.overShort, 4) ?? "0")
                        : "0";
                    onCloseoutChange({
                      ...closeout,
                      overShort: add(priorOverShort, tillSuggestion.difference),
                    });
                  }}
                >
                  {t("tenders.tillDifferenceApply")}
                </Button>
              ) : null}
            </div>
          ) : null}
          {editable && onCloseoutChange ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t("tenders.closeoutHint")}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
