"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@openbooks/ui";
import {
  readSampleCompanyStatus,
  type SampleCompanyRefusal,
  type SampleCompanyRun,
  type SampleCompanyStatusRead,
} from "../lib/sample-company-response";

/** How often an in-progress sample company is re-read while it is shown. */
export const SAMPLE_COMPANY_POLL_MS = 1500;

/**
 * Codes for requests the server refused before any preparation started. The
 * outcome is certain, so asking again is safe; every other failure leaves
 * readiness unconfirmed and is only re-read.
 */
export const SAMPLE_COMPANY_NOT_STARTED_CODES: ReadonlySet<string> = new Set([
  "sample-company-worker-unavailable",
  "sample-company-queue-unavailable",
]);

// Authored server remedies take precedence. A code-only response uses the
// localized description of its code without inferring any company identity.
const FAILURE_COPY: Record<string, string> = {
  "sample-company-template-failed": "createFailedTemplate",
  "sample-company-clone-failed": "createFailedClone",
  "sample-company-finalize-failed": "createFailedFinalize",
  "sample-company-numbering-failed": "createFailedNumbering",
  "sample-company-worker-unavailable": "createFailedWorker",
  "sample-company-queue-unavailable": "createFailedQueue",
};

type SampleTranslator = ReturnType<typeof useTranslations<"data.import.sample">>;

/** The operator-facing sentence for a sample-company refusal. */
export function sampleCompanyRefusalText(t: SampleTranslator, refusal: SampleCompanyRefusal) {
  if (refusal.message && refusal.message.trim() !== "") return refusal.message;
  const key = refusal.code ? FAILURE_COPY[refusal.code] : undefined;
  return key ? t(key as Parameters<SampleTranslator>[0]) : t("createFailed");
}

/**
 * Re-read each listed industry's sample company until its consumer stops
 * listing it. Reads that prove nothing (a dropped connection, an unavailable
 * server) are reported as `unavailable` and watching continues.
 */
export function useSampleCompanyWatch(
  industries: readonly string[],
  onRead: (industry: string, read: SampleCompanyStatusRead) => void,
): void {
  const onReadRef = useRef(onRead);
  useEffect(() => {
    onReadRef.current = onRead;
  });
  const key = [...industries].sort().join("\n");
  useEffect(() => {
    if (!key) return;
    const watched = key.split("\n");
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      for (const industry of watched) {
        let read: SampleCompanyStatusRead;
        try {
          read = await readSampleCompanyStatus(
            await fetch(`/api/data/sample-companies?industry=${encodeURIComponent(industry)}`, {
              cache: "no-store",
            }),
          );
        } catch {
          read = { kind: "unavailable" };
        }
        if (cancelled) return;
        onReadRef.current(industry, read);
      }
      if (!cancelled) timer = window.setTimeout(poll, SAMPLE_COMPANY_POLL_MS);
    };
    timer = window.setTimeout(poll, SAMPLE_COMPANY_POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [key]);
}

const STEPS = ["template", "clone", "finalize"] as const;

/** Live progress of one sample company being prepared in the background. */
export function SampleCompanyProgress({
  run,
  className,
}: {
  run: SampleCompanyRun;
  className?: string;
}) {
  const t = useTranslations("data.import.sample.progress");
  // Numbering reconciliation is part of finalizing for the operator.
  const step = run.stage === "numbering" ? "finalize" : run.stage;
  const label = step ? t(step) : run.state === "running" ? t("starting") : t("queued");
  const position = step ? STEPS.indexOf(step) + 1 : 0;
  return (
    <Alert variant="info" role="status" aria-live="polite" aria-atomic="true" className={className}>
      <div className="flex items-start gap-3">
        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
        <div className="min-w-0 space-y-1">
          <AlertTitle>{t("title")}</AlertTitle>
          <AlertDescription>
            <p className="font-medium">
              {position > 0 ? t("step", { current: position, total: STEPS.length, label }) : label}
            </p>
            <p className="text-xs opacity-80">{t("hint")}</p>
          </AlertDescription>
        </div>
      </div>
    </Alert>
  );
}
