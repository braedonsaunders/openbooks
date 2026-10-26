"use client";

import { useIdentityState } from "@/lib/use-identity-state";
import { useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Label } from "@openbooks/ui";
import { readApiErrorMessage } from "@/lib/api-error";
import type { OperatingProfileChoice } from "@openbooks/engine/organization/operating-profiles";
import type { WorkFamily } from "@openbooks/engine/organization/operating-profile-model";
import { OperatingProfileCards } from "./operating-profile-cards";
import { RemoteRecordChoice } from "./remote-record-choice";

/** Optional department narrows offered workflows. Selecting a card continues inside the existing record drawer. */
export function OperatingProfilePicker({
  family,
  initialChoices,
  departmentId = "",
  value,
  onChoose,
  onDepartmentChange,
}: {
  family: WorkFamily;
  initialChoices?: OperatingProfileChoice[];
  departmentId?: string;
  value: string | null;
  onChoose: (choice: OperatingProfileChoice, departmentId: string) => void;
  onDepartmentChange?: (departmentId: string) => void;
}) {
  const t = useTranslations("operatingProfiles");
  const departmentControlId = useId();
  const [department, setDepartment] = useState(departmentId);
  const [retry, setRetry] = useState(0);
  const [choices, setChoices] = useIdentityState<OperatingProfileChoice[] | null>(
    [family, department, retry],
    initialChoices ?? null,
  );
  const [error, setError] = useIdentityState<string | null>([family, department, retry], null);
  const [loading, setLoading] = useIdentityState([family, department, retry], true);
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({
      family,
      ...(department ? { departmentId: department } : {}),
    });
    void fetch("/api/operating-profiles/choices?" + query, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiErrorMessage(response, t("loadFailed")));
        return (await response.json()) as { choices: OperatingProfileChoice[] };
      })
      .then((result) => {
        if (!controller.signal.aborted) setChoices(result.choices);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : t("loadFailed"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [family, department, retry, t, setChoices, setError, setLoading]);
  return (
    <div className="space-y-5">
      <div className="max-w-sm space-y-1.5">
        <Label htmlFor={departmentControlId}>{t("department")}</Label>
        <RemoteRecordChoice
          id={departmentControlId}
          value={department}
          options={[]}
          endpoint={"/api/operating-profiles/departments?family=" + family}
          disabled={loading}
          clearable
          onChange={(next) => {
            setDepartment(next);
            onDepartmentChange?.(next);
          }}
          labels={{
            choose: t("companyDefaults"),
            searchPlaceholder: t("time.search"),
            loadFailed: t("loadFailed"),
            retry: t("retry"),
          }}
        />
      </div>
      {error ? (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-red-700">{error}</p>
          <Button variant="outline" onClick={() => setRetry((r) => r + 1)}>
            {t("retry")}
          </Button>
        </div>
      ) : loading ? (
        <p role="status" className="text-sm text-slate-500">
          {t("loading")}
        </p>
      ) : choices?.length ? (
        <OperatingProfileCards
          choices={choices}
          value={value}
          onChoose={(choice) => onChoose(choice, department)}
        />
      ) : (
        <p className="text-sm text-slate-500">{t("noChoices")}</p>
      )}
    </div>
  );
}
