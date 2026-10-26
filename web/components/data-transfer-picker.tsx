"use client";
import { useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { Alert, Button, Label, Select } from "@openbooks/ui";
import { readApiErrorMessage } from "../lib/api-error";
import { requestTransfer } from "../lib/data-io/transfer-client";
import type { TransferJob, TransferSummary } from "../lib/data-io/transfer-contract";

/** Operators can reopen durable work after navigation or a lost browser tab. */
export function DataTransferPicker({
  kind,
  job,
  onChange,
  disabled = false,
}: {
  kind: TransferJob["kind"];
  job: TransferJob | null;
  onChange: (job: TransferJob) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("data.transfer"),
    tCommon = useTranslations("common"),
    id = useId();
  const [jobs, setJobs] = useState<TransferSummary[]>([]),
    [listError, setListError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumping this re-runs the list request after a failed load.
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    void fetch("/api/data/transfers", { cache: "no-store", signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiErrorMessage(response, t("loadFailed")));
        const result = await response.json();
        if (!abort.signal.aborted) {
          setListError(null);
          setJobs((result.jobs ?? []).filter((item: TransferSummary) => item.kind === kind));
        }
      })
      .catch((error: Error) => {
        if (!abort.signal.aborted) setListError(error.message);
      });
    return () => abort.abort();
  }, [kind, job?.id, job?.state, reloadKey, t]);
  if (!jobs.length && !listError) return null;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t("recent")}</Label>
      <Select
        id={id}
        value={job?.id ?? ""}
        disabled={loading || disabled}
        onChange={async (event) => {
          if (!event.target.value) return;
          setLoading(true);
          setError(null);
          try {
            onChange(
              await requestTransfer(
                `/api/data/transfers/${encodeURIComponent(event.target.value)}`,
              ),
            );
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setLoading(false);
          }
        }}
      >
        <option value="">{t("choose")}</option>
        {jobs.map((item) => (
          <option key={item.id} value={item.id}>
            {item.filename} · {t(`states.${item.state}`)}
          </option>
        ))}
      </Select>
      {listError && (
        <div className="flex flex-wrap items-center gap-2">
          <Alert variant="destructive">{listError}</Alert>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setListError(null);
              setReloadKey((key) => key + 1);
            }}
          >
            {tCommon("actions.retry")}
          </Button>
        </div>
      )}
      {error && <Alert variant="destructive">{error}</Alert>}
    </div>
  );
}
