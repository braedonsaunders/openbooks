"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { portalAction, ActionError } from "./portal-client";
import { DateField } from "../date-field";

const inputClass =
  "mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-white";
const buttonClass =
  "rounded-xl bg-teal-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:opacity-50";

/** The customer's service request form. The client key makes a resubmitted form return the same request. */
export function ServiceRequestForm({
  sessionToken,
  addresses,
}: {
  sessionToken: string;
  addresses: Array<{ value: string; label: string }>;
}) {
  const t = useTranslations("service.portal");
  const router = useRouter();
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [preferredOn, setPreferredOn] = useState("");
  const [preferredTime, setPreferredTime] = useState("any");
  const [addressId, setAddressId] = useState(addresses[0]?.value ?? "");
  const [urgent, setUrgent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await portalAction<{ requestNumber: string }>("/api/portal/service-requests", {
        sessionToken,
        id: key,
        title: title.trim(),
        description: description.trim() || null,
        preferredOn: preferredOn || null,
        preferredTime,
        urgent,
        serviceAddressId: addressId || null,
      });
      setDone(t("submitted", { number: result.requestNumber }));
      setKey(crypto.randomUUID());
      setTitle("");
      setDescription("");
      setPreferredOn("");
      setUrgent(false);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      {done ? (
        <p
          role="status"
          className="rounded-xl bg-teal-50 p-3 text-sm font-medium text-teal-800 dark:bg-teal-950 dark:text-teal-200"
        >
          {done}
        </p>
      ) : null}
      <label className="block">
        <span className="text-sm text-slate-600 dark:text-slate-300">{t("fields.title")}</span>
        <input
          required
          maxLength={200}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          className={inputClass}
          placeholder={t("fields.titlePlaceholder")}
        />
      </label>
      <label className="block">
        <span className="text-sm text-slate-600 dark:text-slate-300">
          {t("fields.description")}
        </span>
        <textarea
          rows={4}
          maxLength={8000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className={inputClass}
        />
      </label>
      {addresses.length ? (
        <label className="block">
          <span className="text-sm text-slate-600 dark:text-slate-300">{t("fields.address")}</span>
          <select
            value={addressId}
            onChange={(event) => setAddressId(event.target.value)}
            className={inputClass}
          >
            {addresses.map((address) => (
              <option key={address.value} value={address.value}>
                {address.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <label className="min-w-40 flex-1">
          <span className="text-sm text-slate-600 dark:text-slate-300">
            {t("fields.preferredOn")}
          </span>
          <DateField
            value={preferredOn}
            onChange={setPreferredOn}
            className={inputClass}
            aria-label={t("fields.preferredOn")}
          />
        </label>
        <label className="min-w-40 flex-1">
          <span className="text-sm text-slate-600 dark:text-slate-300">
            {t("fields.preferredTime")}
          </span>
          <select
            value={preferredTime}
            onChange={(event) => setPreferredTime(event.target.value)}
            className={inputClass}
          >
            {(["any", "morning", "afternoon", "evening"] as const).map((value) => (
              <option key={value} value={value}>
                {t(`time.${value}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
        <input
          type="checkbox"
          checked={urgent}
          onChange={(event) => setUrgent(event.target.checked)}
        />
        {t("fields.urgent")}
      </label>
      <button type="submit" disabled={busy || !title.trim()} className={buttonClass}>
        {busy ? t("submitting") : t("submit")}
      </button>
      <ActionError message={error} />
    </form>
  );
}
