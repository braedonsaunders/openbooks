import { Badge } from "@openbooks/ui";
import { ExternalRefChip } from "./external-ref-chip";
import { DocTypeBadge } from "./doc-type-badge";

export const STATUS_VARIANT: Record<
  string,
  "default" | "success" | "secondary" | "warning" | "outline"
> = {
  open: "default",
  paid: "success",
  posted: "success",
  approved: "success",
  pending_approval: "warning",
  draft: "secondary",
  voided: "outline",
};

export const STATUS_KEYS: Record<string, string> = {
  draft: "draft",
  pending_approval: "pendingApproval",
  approved: "approved",
  posted: "posted",
  open: "open",
  paid: "paid",
  voided: "voided",
};

/**
 * Drawer title row: type badge + document number + status pill. The status
 * is decision-relevant (open/paid/voided), so the pill must never be the
 * thing that clips on narrow viewports — it keeps its width and wraps to
 * its own line instead.
 */
export function DocumentDrawerTitle({
  kind,
  documentNumber,
  statusLabel,
  statusVariant,
  externalRef,
  externalSource,
}: {
  kind: string;
  documentNumber: string;
  statusLabel: string;
  statusVariant: "default" | "success" | "secondary" | "warning" | "outline";
  externalRef?: string | null;
  externalSource?: string | null;
}) {
  return (
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
      <DocTypeBadge kind={kind} />
      <span className="font-mono">{documentNumber}</span>
      <Badge variant={statusVariant} className="shrink-0">
        {statusLabel}
      </Badge>
      <ExternalRefChip externalRef={externalRef} externalSource={externalSource} />
    </span>
  );
}
