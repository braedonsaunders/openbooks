"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@openbooks/ui";
import { readApiErrorMessage } from "../../../../../lib/api-error";

/** The composer's primary action: create the batch run and land on its run. */
export function SendBatchButton({
  recipientCount,
  canCreate,
  notAllowed,
  buttonLabel,
  sendingLabel,
  body,
}: {
  recipientCount: number;
  canCreate: boolean;
  notAllowed: string;
  buttonLabel: string;
  sendingLabel: string;
  body: {
    from: string | null;
    toDate: string;
    overdueOnly: boolean;
    subsidiaryId: string | null;
    currency: string | null;
  };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!canCreate) return <p className="text-sm text-slate-500 dark:text-slate-400">{notAllowed}</p>;
  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        disabled={busy || recipientCount === 0}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const res = await fetch("/api/statement-batches", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error(await readApiErrorMessage(res, buttonLabel));
            const data = (await res.json()) as { runId: string };
            router.push(`/reports/statements/sends?run=${encodeURIComponent(data.runId)}`);
          } catch (e) {
            setError(e instanceof Error ? e.message : buttonLabel);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? sendingLabel : buttonLabel}
      </Button>
      {error ? <span className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
    </span>
  );
}
