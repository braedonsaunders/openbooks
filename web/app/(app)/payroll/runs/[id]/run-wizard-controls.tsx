"use client";

/** Split from RunWizard.tsx; moved without behavior changes. */
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@openbooks/ui";
import { DateField } from "../../../../../components/date-field";

/* ------------------------------------------------------------------ */

export function HeaderFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500">
        {label}
      </dt>
      <dd className="font-medium whitespace-nowrap text-slate-800 tabular-nums dark:text-slate-100">
        {children}
      </dd>
    </div>
  );
}

/**
 * Entity pick + one-click legacy attribution of a subsidiary-less run.
 * Same shape as RecordPaymentControl: a labelled select composed with the
 * action button, so the picker never drifts from the house control pattern.
 */
export function AttributeEntityControl({
  entityOptions,
  busy,
  onAttribute,
}: {
  entityOptions: { id: string; label: string }[];
  busy: boolean;
  onAttribute: (subsidiaryId: string) => void;
}) {
  const t = useTranslations("payroll");
  const [subsidiaryId, setSubsidiaryId] = useState(entityOptions[0]?.id ?? "");
  return (
    <span className="flex items-center gap-2">
      <select
        aria-label={t("wizard.finish.entityTarget")}
        value={subsidiaryId}
        onChange={(e) => setSubsidiaryId(e.target.value)}
        className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
      >
        {entityOptions.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      <Button size="sm" disabled={busy || !subsidiaryId} onClick={() => onAttribute(subsidiaryId)}>
        {t("wizard.finish.attributeEntity")}
      </Button>
    </span>
  );
}

/** Bank pick + one-click settlement of the run's net-pay open items. */
/** One dated net-pay settlement clearing designation, labelled for the picker. */
export interface ClearingDesignationOption {
  id: string;
  accountId: string;
  label: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface RecordPaymentInput {
  bankAccountId?: string;
  settlementClearingAccountId?: string;
  paidOn: string;
}

export function RecordPaymentControl({
  bankAccounts,
  clearingDesignations,
  payDate,
  busy,
  onRecord,
}: {
  bankAccounts: { id: string; label: string }[];
  clearingDesignations: ClearingDesignationOption[];
  /** The run's pay date: the default payment date. */
  payDate: string;
  busy: boolean;
  onRecord: (input: RecordPaymentInput) => void;
}) {
  const t = useTranslations("payroll");
  const [bankAccountId, setBankAccountId] = useState(bankAccounts[0]?.id ?? "");
  const [paidOn, setPaidOn] = useState(payDate);
  const [settleTo, setSettleTo] = useState<"bank" | "clearing">("bank");
  // Only the designation covering the chosen date may receive the settlement.
  const clearing = clearingDesignations.find(
    (designation) =>
      designation.effectiveFrom <= paidOn &&
      (designation.effectiveTo === null || paidOn <= designation.effectiveTo),
  );
  const target = settleTo === "clearing" && clearing ? "clearing" : "bank";
  const selectClass =
    "rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900";
  return (
    <span className="flex flex-wrap items-center gap-2">
      <DateField
        aria-label={t("wizard.finish.settlementPaidOn")}
        value={paidOn}
        onChange={(value) => setPaidOn(value)}
        className={`${selectClass} h-9 w-40`}
      />
      {clearing && (
        <select
          aria-label={t("wizard.finish.settlementSettleTo")}
          value={target}
          onChange={(e) => setSettleTo(e.target.value as "bank" | "clearing")}
          className={selectClass}
        >
          <option value="bank">{t("wizard.finish.settlementBank")}</option>
          <option value="clearing">
            {t("wizard.finish.settlementClearing")} · {clearing.label}
          </option>
        </select>
      )}
      {target === "bank" && (
        <select
          aria-label={t("wizard.finish.bankAccount")}
          value={bankAccountId}
          onChange={(e) => setBankAccountId(e.target.value)}
          className={selectClass}
        >
          {bankAccounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.label}
            </option>
          ))}
        </select>
      )}
      <Button
        size="sm"
        disabled={busy || !paidOn || (target === "bank" && !bankAccountId)}
        onClick={() =>
          onRecord(
            target === "clearing"
              ? { settlementClearingAccountId: clearing!.accountId, paidOn }
              : { bankAccountId, paidOn },
          )
        }
      >
        {t("wizard.finish.recordPayment")}
      </Button>
    </span>
  );
}
