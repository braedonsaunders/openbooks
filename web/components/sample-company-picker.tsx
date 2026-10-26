"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Database, Sparkles } from "lucide-react";
import { Button, Card, Label, Select } from "@openbooks/ui";
import {
  switchWorkspace,
  WorkspaceSwitchError,
  workspaceSwitchMessageKey,
} from "../lib/workspace-switch";
import { readApiErrorMessage } from "../lib/api-error";
import {
  readSampleCompanyResponse,
  type SampleCompanyRefusal,
} from "../lib/sample-company-response";

interface SampleCompanyProfile {
  industryKey: string;
  profileId: string;
  companyName: string;
  focus: string[];
  templateReady: boolean;
  existingOrgId: string | null;
}

// Authored server remedies take precedence. A code-only response uses the
// localized stage description without inferring any company identity.
export const SAMPLE_COMPANY_FAILURE_COPY: Record<string, string> = {
  "sample-company-template-failed": "import.sample.createFailedTemplate",
  "sample-company-clone-failed": "import.sample.createFailedClone",
  "sample-company-finalize-failed": "import.sample.createFailedFinalize",
  "sample-company-numbering-failed": "import.sample.createFailedNumbering",
};

export function SampleCompanyPicker() {
  const t = useTranslations("data");
  const tSwitch = useTranslations("shell.accountMenu");
  const [sampleProfiles, setSampleProfiles] = useState<SampleCompanyProfile[]>([]);
  const [sampleIndustry, setSampleIndustry] = useState("");
  const [sampleBusy, setSampleBusy] = useState(false);
  const [sampleErrors, setSampleErrors] = useState<Record<string, SampleCompanyRefusal>>({});
  const inFlight = useRef(false);
  const sampleError = sampleErrors[sampleIndustry] ?? null;
  useEffect(() => {
    // The settings widget mounts after the route shell, so resolve its anchor
    // once the picker exists instead of relying on the initial navigation.
    if (window.location.hash === "#sample-companies") {
      document.getElementById("sample-companies")?.scrollIntoView({ block: "start" });
    }
  }, []);
  const sampleErrorText = (refusal: SampleCompanyRefusal): string => {
    if (refusal.message && refusal.message.trim() !== "") return refusal.message;
    const copyKey = refusal.code ? SAMPLE_COMPANY_FAILURE_COPY[refusal.code] : undefined;
    if (copyKey) return t(copyKey);
    return t("import.sample.createFailed");
  };

  useEffect(() => {
    fetch("/api/data/sample-companies")
      .then(async (r) => {
        if (!r.ok) throw new Error(await readApiErrorMessage(r, t("import.sample.error")));
        return r.json();
      })
      .then((d) => {
        const profiles = (d.profiles ?? []) as SampleCompanyProfile[];
        setSampleProfiles(profiles);
        setSampleIndustry((current) => current || profiles[0]?.industryKey || "");
      })
      .catch((e) => {
        toast.error((e as Error).message);
      });
  }, [t]);

  const selectedSample = useMemo(
    () => sampleProfiles.find((profile) => profile.industryKey === sampleIndustry) ?? null,
    [sampleIndustry, sampleProfiles],
  );

  const createOrOpenSample = async () => {
    if (!selectedSample || inFlight.current) return;
    inFlight.current = true;
    setSampleBusy(true);
    const industry = selectedSample.industryKey;
    let orgId = selectedSample.existingOrgId;
    try {
      // After an uncertain attempt, perform only a read. An accessible ready
      // company may be opened; an absent list entry does not prove no partial
      // company exists and never authorizes another POST here.
      if (sampleError && !orgId) {
        const response = await fetch("/api/data/sample-companies");
        if (!response.ok)
          throw new Error(await readApiErrorMessage(response, t("import.sample.error")));
        const data = (await response.json()) as { profiles?: SampleCompanyProfile[] };
        if (!Array.isArray(data.profiles)) throw new Error(t("import.sample.error"));
        setSampleProfiles(data.profiles);
        orgId =
          data.profiles.find((profile) => profile.industryKey === industry)?.existingOrgId ?? null;
        if (!orgId) return;
      }
      if (!orgId) {
        const response = await fetch("/api/data/sample-companies", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ industry: selectedSample.industryKey }),
        });
        const result = await readSampleCompanyResponse(response);
        if (!result.ok) {
          setSampleErrors((current) => ({ ...current, [industry]: result.refusal }));
          toast.error(sampleErrorText(result.refusal));
          return;
        }
        orgId = result.orgId;
        // Keep the proven identity even when the subsequent workspace switch
        // refuses. The next action opens this company instead of cloning again.
        setSampleProfiles((profiles) =>
          profiles.map((profile) =>
            profile.industryKey === industry
              ? { ...profile, existingOrgId: result.orgId }
              : profile,
          ),
        );
        toast.success(result.created ? t("import.sample.created") : t("import.sample.ready"));
      }
      await switchWorkspace(orgId);
      setSampleErrors((current) => {
        const next = { ...current };
        delete next[industry];
        return next;
      });
    } catch (error) {
      const message =
        error instanceof WorkspaceSwitchError
          ? tSwitch(workspaceSwitchMessageKey(error))
          : orgId && error instanceof Error
            ? error.message
            : undefined;
      setSampleErrors((current) =>
        current[industry] ? current : { ...current, [industry]: { message } },
      );
      toast.error(message ?? t("import.sample.createFailed"));
    } finally {
      inFlight.current = false;
      setSampleBusy(false);
    }
  };

  return (
    <Card id="sample-companies" className="scroll-mt-6">
      <div className="flex items-start gap-3 border-b border-border p-4">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-teal-600 text-white shadow-sm">
          <Sparkles className="h-5 w-5" />
        </span>
        <div>
          <h2 className="font-semibold text-foreground">{t("import.sample.title")}</h2>
          <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
            {t("import.sample.description")}
          </p>
        </div>
      </div>
      <div className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="space-y-2">
          <Label htmlFor="sample-industry">{t("import.sample.industry")}</Label>
          <Select
            id="sample-industry"
            aria-describedby={sampleError ? "sample-company-error" : undefined}
            disabled={sampleBusy}
            value={sampleIndustry}
            onChange={(event) => setSampleIndustry(event.target.value)}
          >
            {sampleProfiles.map((profile) => (
              <option key={profile.industryKey} value={profile.industryKey}>
                {profile.companyName}
              </option>
            ))}
          </Select>
          {selectedSample && (
            <p className="text-xs text-muted-foreground">
              {selectedSample.focus.join(" · ")}
              {!selectedSample.templateReady && !selectedSample.existingOrgId
                ? ` · ${t("import.sample.firstGeneration")}`
                : ""}
            </p>
          )}
          {sampleError && (
            <p
              id="sample-company-error"
              role="alert"
              className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm leading-relaxed text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200"
            >
              {sampleErrorText(sampleError)}
              {sampleError.requestId && (
                <span className="mt-1 block">
                  {t("import.sample.requestReference", { requestId: sampleError.requestId })}
                </span>
              )}
            </p>
          )}
        </div>
        <Button
          type="button"
          onClick={createOrOpenSample}
          disabled={!selectedSample || sampleBusy}
          className="sm:min-w-44"
        >
          <Database className="mr-2 h-4 w-4" />
          {sampleBusy
            ? t("import.sample.preparing")
            : selectedSample?.existingOrgId
              ? t("import.sample.open")
              : sampleError
                ? t("import.sample.checkStatus")
                : t("import.sample.create")}
        </Button>
      </div>
      <p className="px-4 pb-4 text-xs leading-relaxed text-muted-foreground">
        {t("import.sample.safety")}
      </p>
    </Card>
  );
}
