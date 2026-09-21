import Link from "next/link";
import type { FormEvent } from "react";
import { Label, Textarea } from "@openbooks/ui";
import type { TaxMatchingReplayPreview } from "@openbooks/engine/src/tax-returns/consolidated-matching-replay.ts";
import { ChangeEvidence } from "./ChangeEvidence";

/** The existing workpaper form and ChangeEvidence composition. Only the
 * reason is editable; dates, citations and money are server evidence. */
export function TaxMatchingReplayForm({
  formId, preview, reason, busy, onReasonChange, onSubmit,
}: {
  formId: string;
  preview: TaxMatchingReplayPreview | null;
  reason: string;
  busy: boolean;
  onReasonChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form id={formId} className="space-y-5" onSubmit={onSubmit}>
      <p>
        Replay appends approved matching evidence to the replacement workpaper.
        Earlier pool results and the reversed workpaper remain in the audit history.
        After applying the replay, re-run the latest computed tax year only.
      </p>
      <Link className="underline" href="/assets/tax-pools">Open Fixed Assets tax pools</Link>
      {preview ? (
        <>
          <ChangeEvidence taxBasis value={preview} />
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-reason`}>Reason</Label>
            <Textarea
              id={`${formId}-reason`}
              value={reason}
              onChange={(event) => onReasonChange(event.target.value)}
              minLength={8}
              maxLength={1000}
              required
              disabled={busy}
            />
          </div>
        </>
      ) : null}
    </form>
  );
}
