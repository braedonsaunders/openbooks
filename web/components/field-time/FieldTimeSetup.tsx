"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Badge, Button, Input, SearchSelect, Select } from "@openbooks/ui";
import { Field } from "@/components/field";
import { readApiErrorMessage } from "@/lib/api-error";
import { PagedTable, type PagedColumn } from "@/components/paged-table";
import { useViewerFormat } from "@/lib/viewer-format";

export interface FieldTimeRuleSettings {
  roundingIncrement: number | null;
  roundingMode: string | null;
  unpaidBreakMinutes: number | null;
  autoCloseHours: number | null;
  signatureRequired: boolean | null;
  equipmentToleranceHours: string | null;
  photoRequired: boolean | null;
}

export interface KioskRow {
  id: string;
  name: string;
  locationId: string | null;
  projectId: string | null;
  pinRequired: boolean;
  photoRequired: boolean;
  isActive: boolean;
  lastSeenAt: string | null;
}

interface EmployeeOption {
  value: string;
  label: string;
}

/**
 * The field-time setup surface: declared rounding/break/auto-close/
 * signature/tolerance/photo rules, kiosk devices with token issue and
 * revoke plus worker PINs, and where approval routing lives (Flows).
 * Every rule is required — the service refuses without them rather than
 * guessing.
 */
export function FieldTimeSetup({
  initialSettings,
  kiosks,
  employees,
  kioskLinkBase,
  canManageKiosks,
  canEditPolicy,
}: {
  initialSettings: FieldTimeRuleSettings;
  kiosks: KioskRow[];
  employees: EmployeeOption[];
  kioskLinkBase: string;
  /**
   * Loader-resolved from the kiosks API's own authority (time.kiosk.manage
   * plus the fieldTime feature): without it the kiosk section hides
   * instead of offering register/revoke calls that would only 403.
   */
  canManageKiosks: boolean;
  /**
   * Loader-resolved from subsidiary scope: the settings PUT needs
   * unrestricted scope, so a restricted manager reads the policy
   * with disabled forms instead of failing saves.
   */
  canEditPolicy: boolean;
}) {
  const t = useTranslations("timesheets");
  const common = useTranslations("common");
  const { dateTime } = useViewerFormat();
  const [settings, setSettings] = useState<FieldTimeRuleSettings>(initialSettings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
  const [kioskRows, setKioskRows] = useState(kiosks);
  const [kioskName, setKioskName] = useState("");
  const [pinWorker, setPinWorker] = useState("");
  const [pin, setPin] = useState("");
  const revealRefusal = useCallback((element: HTMLParagraphElement | null) => {
    element?.scrollIntoView({ block: "nearest" });
  }, []);

  const saveSettings = useCallback(async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/time/settings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          roundingIncrement: settings.roundingIncrement,
          roundingMode: settings.roundingMode,
          unpaidBreakMinutes: settings.unpaidBreakMinutes,
          autoCloseHours: settings.autoCloseHours,
          signatureRequired: settings.signatureRequired,
          equipmentToleranceHours: settings.equipmentToleranceHours,
          photoRequired: settings.photoRequired,
        }),
      });
      // The refusal reads through the shared helper so message, remedy and
      // code render instead of a bare fallback.
      if (!res.ok) {
        setError(await readApiErrorMessage(res, t("field.sendFailed")));
        return;
      }
      setSaved(true);
    } catch {
      setError(t("field.sendFailed"));
    } finally {
      setBusy(false);
    }
  }, [settings, t]);

  const registerKiosk = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/time/kiosks", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: kioskName.trim() }),
      });
      // The refusal reads through the shared helper so message, remedy and
      // code render instead of a bare fallback; the success body parses
      // after the ok check.
      if (!res.ok) {
        setError(await readApiErrorMessage(res, t("field.sendFailed")));
        return;
      }
      const payload = (await res.json().catch(() => null)) as {
        kiosk?: KioskRow;
        token?: string;
      } | null;
      if (!payload?.token) {
        setError(t("field.sendFailed"));
        return;
      }
      setIssued({ name: payload.kiosk?.name ?? kioskName.trim(), token: payload.token });
      if (payload.kiosk)
        setKioskRows((current) => [
          ...current.filter((kiosk) => kiosk.id !== payload.kiosk!.id),
          payload.kiosk!,
        ]);
      setKioskName("");
    } catch {
      setError(t("field.sendFailed"));
    } finally {
      setBusy(false);
    }
  }, [kioskName, t]);

  const setPinFor = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/time/kiosks", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "set-pin",
          employeePartyId: pinWorker.trim(),
          pin: pin.trim(),
        }),
      });
      // The refusal reads through the shared helper so message, remedy and
      // code render instead of a bare fallback.
      if (!res.ok) {
        setError(await readApiErrorMessage(res, t("field.sendFailed")));
        return;
      }
      setPinWorker("");
      setPin("");
      setSaved(true);
    } catch {
      setError(t("field.sendFailed"));
    } finally {
      setBusy(false);
    }
  }, [pinWorker, pin, t]);

  const revokeDevice = useCallback(
    async (kioskId: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/time/kiosks", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "revoke", kioskId }),
        });
        if (!res.ok) {
          setError(await readApiErrorMessage(res, t("field.sendFailed")));
          return;
        }
        setKioskRows((current) =>
          current.map((row) => (row.id === kioskId ? { ...row, isActive: false } : row)),
        );
      } catch {
        setError(t("field.sendFailed"));
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  const kioskColumns: PagedColumn<KioskRow>[] = [
    {
      key: "name",
      header: common("labels.name"),
      cell: (row) => row.name,
      search: (row) => row.name,
    },
    {
      key: "status",
      header: t("field.statusLabel"),
      cell: (row) => (
        <Badge variant={row.isActive ? "success" : "secondary"}>
          {row.isActive ? t("field.activeBadge") : t("field.inactiveBadge")}
        </Badge>
      ),
      search: (row) => (row.isActive ? t("field.activeBadge") : t("field.inactiveBadge")),
    },
    {
      key: "pinRequired",
      header: t("field.pinRequired"),
      cell: (row) => (row.pinRequired ? common("labels.yes") : common("labels.no")),
    },
    {
      key: "photoRequired",
      header: t("field.flagPhoto"),
      cell: (row) => (row.photoRequired ? common("labels.yes") : common("labels.no")),
    },
    {
      key: "lastSeenAt",
      header: t("field.lastSeen"),
      cell: (row) =>
        row.lastSeenAt ? dateTime(new Date(row.lastSeenAt)) : common("labels.notSet"),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (row) =>
        row.isActive ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void revokeDevice(row.id)}
          >
            {common("actions.retire")}
          </Button>
        ) : null,
    },
  ];

  const num = (value: string): number | null => {
    if (value.trim() === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-base font-semibold">{t("field.rulesTitle")}</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={t("field.roundingIncrement")}>
            <Select
              value={settings.roundingIncrement == null ? "" : String(settings.roundingIncrement)}
              disabled={!canEditPolicy}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  roundingIncrement: event.target.value === "" ? null : Number(event.target.value),
                }))
              }
            >
              <option value="">{t("field.notDeclared")}</option>
              <option value="0">{t("field.roundingNone")}</option>
              <option value="6">{t("field.rounding6")}</option>
              <option value="15">{t("field.rounding15")}</option>
            </Select>
          </Field>
          <Field label={t("field.roundingMode")}>
            <Select
              value={settings.roundingMode ?? ""}
              disabled={!canEditPolicy}
              onChange={(event) =>
                setSettings((prev) => ({ ...prev, roundingMode: event.target.value || null }))
              }
            >
              <option value="">{t("field.notDeclared")}</option>
              <option value="nearest">{t("field.roundNearest")}</option>
              <option value="up">{t("field.roundUp")}</option>
              <option value="down">{t("field.roundDown")}</option>
            </Select>
          </Field>
          <Field label={t("field.unpaidBreak")}>
            <Input
              value={settings.unpaidBreakMinutes == null ? "" : String(settings.unpaidBreakMinutes)}
              disabled={!canEditPolicy}
              onChange={(event) =>
                setSettings((prev) => ({ ...prev, unpaidBreakMinutes: num(event.target.value) }))
              }
              inputMode="numeric"
              placeholder="30"
            />
          </Field>
          <Field label={t("field.autoClose")}>
            <Input
              value={settings.autoCloseHours == null ? "" : String(settings.autoCloseHours)}
              disabled={!canEditPolicy}
              onChange={(event) =>
                setSettings((prev) => ({ ...prev, autoCloseHours: num(event.target.value) }))
              }
              inputMode="decimal"
              placeholder="16"
            />
          </Field>
          <Field label={t("field.equipmentTolerance")}>
            <Input
              value={settings.equipmentToleranceHours ?? ""}
              disabled={!canEditPolicy}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  equipmentToleranceHours: event.target.value.trim() || null,
                }))
              }
              inputMode="decimal"
              placeholder="0.5"
            />
          </Field>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={t("field.signatureRequired")}>
            <Select
              value={settings.signatureRequired === null ? "" : String(settings.signatureRequired)}
              disabled={!canEditPolicy}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  signatureRequired:
                    event.target.value === "" ? null : event.target.value === "true",
                }))
              }
            >
              <option value="">{t("field.notDeclared")}</option>
              <option value="true">{common("labels.yes")}</option>
              <option value="false">{common("labels.no")}</option>
            </Select>
          </Field>
          <Field label={t("field.photoRequiredSetting")}>
            <Select
              value={settings.photoRequired === null ? "" : String(settings.photoRequired)}
              disabled={!canEditPolicy}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  photoRequired: event.target.value === "" ? null : event.target.value === "true",
                }))
              }
            >
              <option value="">{t("field.notDeclared")}</option>
              <option value="true">{common("labels.yes")}</option>
              <option value="false">{common("labels.no")}</option>
            </Select>
          </Field>
        </div>
        {canEditPolicy ? (
          <Button disabled={busy} onClick={saveSettings}>
            {busy ? t("field.working") : t("field.saveRules")}
          </Button>
        ) : null}
        {saved ? <p className="text-sm text-teal-700">{t("field.rulesSaved")}</p> : null}
      </section>

      {canManageKiosks ? (
        <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-base font-semibold">{t("field.kiosksTitle")}</h2>
          <PagedTable
            source="time_kiosks"
            rows={kioskRows}
            columns={kioskColumns}
            rowKey={(row) => row.id}
            searchable
            empty={<span>{t("field.noKiosks")}</span>}
          />
          {issued ? (
            <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800" role="status">
              <p>{t("field.tokenIssued", { name: issued.name })}</p>
              <p className="mt-1 break-all font-mono text-xs">
                {kioskLinkBase}/{issued.token}
              </p>
              <Button variant="outline" className="mt-2" onClick={() => setIssued(null)}>
                {t("field.acknowledgeToken")}
              </Button>
            </div>
          ) : null}
          <div className="flex gap-2">
            <Field label={t("field.kioskNamePlaceholder")}>
              <Input
                value={kioskName}
                onChange={(event) => setKioskName(event.target.value)}
                placeholder={t("field.kioskNamePlaceholder")}
                className="max-w-xs"
              />
            </Field>
            <Button
              variant="outline"
              disabled={busy || Boolean(issued) || !kioskName.trim()}
              onClick={registerKiosk}
            >
              {t("field.registerKiosk")}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Field label={t("field.worker")}>
              <SearchSelect
                value={pinWorker}
                onChange={setPinWorker}
                options={employees}
                placeholder={t("field.chooseWorker")}
                searchPlaceholder={t("field.kioskSearchPlaceholder")}
                emptyLabel={t("field.chooseWorker")}
                className="max-w-xs"
              />
            </Field>
            <Field label={t("field.pinPlaceholder")}>
              <Input
                value={pin}
                onChange={(event) => setPin(event.target.value)}
                placeholder={t("field.pinPlaceholder")}
                inputMode="numeric"
                autoComplete="off"
                className="max-w-40"
              />
            </Field>
            <Button
              variant="outline"
              disabled={busy || !pinWorker.trim() || !pin.trim()}
              onClick={setPinFor}
            >
              {t("field.setPin")}
            </Button>
          </div>
        </section>
      ) : null}

      <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-base font-semibold">{t("field.approvalRoutingTitle")}</h2>
        <p className="text-sm text-slate-500">{t("field.approvalRoutingHint")}</p>
        <Link
          href="/admin/flows"
          className="text-sm font-medium text-teal-700 hover:underline dark:text-teal-400"
        >
          {t("field.approvalRoutingLink")}
        </Link>
      </section>

      {error ? (
        <p ref={revealRefusal} className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
