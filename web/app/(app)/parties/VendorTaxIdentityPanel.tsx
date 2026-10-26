"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { fetchAction } from "@braedonsaunders/appkit-errors";
import { ActionAlert } from "@braedonsaunders/appkit-errors/react";
import { Input, Label, Select } from "@openbooks/ui";
import { useAppAction } from "../../../lib/use-app-action";
import { useRecordSaveParticipant } from "../../../components/record-save-participants";

export interface VendorTaxIdentity {
  tinLast4: string | null;
  tinType: string | null;
  taxClassification: string | null;
  informationReturnForm: string | null;
  informationReturnBox: string | null;
  backupWithholding: boolean;
  reportable: boolean;
}

const TAX_CLASSIFICATIONS = [
  "individual",
  "sole_proprietor",
  "partnership",
  "c_corp",
  "s_corp",
  "llc",
  "trust_estate",
  "government",
  "nonprofit",
  "other",
] as const;

const TIN_TYPES = ["ein", "ssn", "itin", "atin", "sin", "bn", "unknown"] as const;

/**
 * The vendor drawer's tax-identity section: the masked TIN on file plus the
 * filing classification the information return needs. Rides the
 * informationReturns tax switch — not subcontractor compliance — so a 1099
 * filer with no COI tracking still captures W-9 identity on the payee record.
 *
 * The TIN itself is write-only: the loader passes only the last four digits,
 * the input holds a freshly typed number until save, and the save posts it to
 * PATCH /api/compliance/vendors/[partyId], which seals it at rest, keeps only
 * the last four in plaintext, and audits the change without the ciphertext.
 */
export function VendorTaxIdentityPanel({
  partyId,
  initial,
  formTypes,
  editable,
}: {
  partyId: string;
  initial: VendorTaxIdentity;
  formTypes: string[];
  /** The drawer is in edit mode and the viewer holds compliance.manage. */
  editable: boolean;
}) {
  const t = useTranslations("compliance");
  const { refusal, execute, clearRefusal } = useAppAction();
  const [saved, setSaved] = useState({ ...initial, tin: "" });
  const [form, setForm] = useState(saved);
  const dirty =
    form.tin !== "" ||
    form.tinType !== saved.tinType ||
    form.taxClassification !== saved.taxClassification ||
    form.informationReturnForm !== saved.informationReturnForm ||
    form.informationReturnBox !== saved.informationReturnBox ||
    form.backupWithholding !== saved.backupWithholding ||
    form.reportable !== saved.reportable;

  useRecordSaveParticipant("taxIdentity", {
    dirty,
    save: async () => {
      const ok = await execute(
        () =>
          fetchAction(`/api/compliance/vendors/${partyId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              taxClassification: form.taxClassification || null,
              reportable: form.reportable,
              informationReturnForm: form.informationReturnForm || null,
              informationReturnBox: form.informationReturnBox || null,
              tinType: form.tinType || null,
              // Only send the TIN when it was actually typed — an empty field
              // means "leave the sealed value alone", never "erase it".
              ...(form.tin ? { tin: form.tin } : {}),
              backupWithholding: form.backupWithholding,
            }),
          }),
        { fallbackMessage: t("taxIdentity.saveFailed") },
      );
      if (ok) {
        // A typed TIN saved, so its last four are now on file — show them
        // without waiting for a reload. Untouched otherwise.
        const next = {
          ...form,
          tin: "",
          tinLast4: form.tin ? form.tin.replace(/[\s-]/g, "").slice(-4) : form.tinLast4,
        };
        setSaved(next);
        setForm(next);
      }
      return ok;
    },
    reset: () => {
      setForm(saved);
      clearRefusal();
    },
  });

  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {t("taxIdentity.heading")}
        </h3>
        <p className="text-xs text-slate-500 dark:text-slate-400">{t("taxIdentity.description")}</p>
      </div>
      <ActionAlert error={refusal} fallbackMessage={t("taxIdentity.saveFailed")} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>{t("fields.tin")}</Label>
          {editable ? (
            <>
              <Input
                value={form.tin}
                inputMode="numeric"
                placeholder={saved.tinLast4 ? `•••••${saved.tinLast4}` : t("fields.tinPlaceholder")}
                onChange={(event) => setForm({ ...form, tin: event.target.value })}
              />
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {t("fields.tinHint")}
              </p>
            </>
          ) : (
            <p className="text-sm tabular-nums text-slate-700 dark:text-slate-300">
              {saved.tinLast4 ? `•••••${saved.tinLast4}` : t("readiness.missingTin")}
            </p>
          )}
        </div>
        <div>
          <Label>{t("fields.tinType")}</Label>
          {editable ? (
            <Select
              value={form.tinType ?? ""}
              onChange={(event) => setForm({ ...form, tinType: event.target.value || null })}
            >
              <option value="">{t("fields.select")}</option>
              {TIN_TYPES.map((value) => (
                <option key={value} value={value}>
                  {t(`tinType.${value}`)}
                </option>
              ))}
            </Select>
          ) : (
            <p className="text-sm text-slate-700 dark:text-slate-300">
              {form.tinType ? t(`tinType.${form.tinType}`) : t("fields.unknown")}
            </p>
          )}
        </div>
        <div>
          <Label>{t("fields.taxClassification")}</Label>
          {editable ? (
            <Select
              value={form.taxClassification ?? ""}
              onChange={(event) =>
                setForm({ ...form, taxClassification: event.target.value || null })
              }
            >
              <option value="">{t("fields.unknown")}</option>
              {TAX_CLASSIFICATIONS.map((value) => (
                <option key={value} value={value}>
                  {t(`taxClassification.${value}`)}
                </option>
              ))}
            </Select>
          ) : (
            <p className="text-sm text-slate-700 dark:text-slate-300">
              {form.taxClassification
                ? t(`taxClassification.${form.taxClassification}`)
                : t("fields.unknown")}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 pt-6">
          <input
            type="checkbox"
            checked={form.reportable}
            disabled={!editable}
            onChange={(event) => setForm({ ...form, reportable: event.target.checked })}
          />
          <span className="text-sm">{t("fields.reportable")}</span>
        </div>
        <div>
          <Label>{t("fields.informationReturnForm")}</Label>
          {editable ? (
            <Select
              value={form.informationReturnForm ?? ""}
              disabled={!form.reportable}
              onChange={(event) =>
                setForm({ ...form, informationReturnForm: event.target.value || null })
              }
            >
              <option value="">{t("fields.inheritClass")}</option>
              <option value="none">{t("fields.notReportable")}</option>
              {formTypes.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          ) : (
            <p className="text-sm text-slate-700 dark:text-slate-300">
              {form.informationReturnForm ?? t("fields.inheritClass")}
            </p>
          )}
        </div>
        <div>
          <Label>{t("fields.informationReturnBox")}</Label>
          {editable ? (
            <Input
              value={form.informationReturnBox ?? ""}
              placeholder={t("fields.defaultBox")}
              onChange={(event) =>
                setForm({ ...form, informationReturnBox: event.target.value || null })
              }
            />
          ) : (
            <p className="text-sm text-slate-700 dark:text-slate-300">
              {form.informationReturnBox ?? t("fields.defaultBox")}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 pt-6">
          <input
            type="checkbox"
            checked={form.backupWithholding}
            disabled={!editable}
            onChange={(event) => setForm({ ...form, backupWithholding: event.target.checked })}
          />
          <span className="text-sm">{t("fields.backupWithholding")}</span>
        </div>
      </div>
    </section>
  );
}
