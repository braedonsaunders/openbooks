"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Trash2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@openbooks/ui";
import { confirmDialog } from "@/lib/confirm";
import { readApiErrorMessage } from "@/lib/api-error";

/**
 * Delete one statement import from the account's import history. The engine
 * is authoritative: it refuses matched, excluded, signed-off-history and
 * duplicate-flagged imports with named remedies, surfaced here as the
 * failure toast. A blocked import renders its reason on the disabled
 * control instead of offering a delete that cannot succeed — and when
 * matches are the blocker, an Unmatch-all action releases the import so
 * its delete can proceed (signed-off sessions still refuse).
 */
export function StatementDeleteCell({
  statementId,
  lineCount,
  blockedReason,
  confirmMessage,
  showDelete,
  matchedCount,
  unmatchAllConfirmMessage,
}: {
  statementId: string;
  lineCount: number;
  blockedReason: string | null;
  confirmMessage: string;
  showDelete?: boolean;
  matchedCount?: number;
  unmatchAllConfirmMessage?: string;
}) {
  const t = useTranslations("banking.account");
  const tBanking = useTranslations("banking");
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function unmatchAll() {
    if (busy) return;
    const ok = await confirmDialog({
      message: unmatchAllConfirmMessage ?? "",
      confirmLabel: t("unmatchAll"),
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/banking/statements/${statementId}/unmatch-all`, {
        method: "POST",
      });
      // The body parses from a clone so the refusal can read through the
      // shared helper while the success toast keeps its counts.
      const data = (await res
        .clone()
        .json()
        .catch(() => null)) as { error?: unknown; unmatchedLines?: unknown } | null;
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, tBanking("errors.requestFailed")));
        return;
      }
      toast.success(
        t("unmatchedToast", {
          count:
            typeof data?.unmatchedLines === "number" ? data.unmatchedLines : (matchedCount ?? 0),
        }),
      );
      router.refresh();
    } catch {
      toast.error(tBanking("errors.requestFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (!showDelete) return null;
  if (blockedReason) {
    return (
      <span className="inline-flex items-center gap-1">
        {(matchedCount ?? 0) > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            title={t("unmatchAll")}
            aria-label={t("unmatchAll")}
            onClick={unmatchAll}
          >
            <Undo2 size={14} />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          disabled
          title={blockedReason}
          aria-label={t("deleteImport")}
        >
          <Trash2 size={14} />
        </Button>
      </span>
    );
  }

  async function run() {
    const ok = await confirmDialog({
      message: confirmMessage,
      confirmLabel: t("deleteImport"),
      tone: "danger",
    });
    if (!ok || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/banking/statements/${statementId}`, { method: "DELETE" });
      // The body parses from a clone so the refusal can read through the
      // shared helper while the success toast keeps its counts.
      const data = (await res
        .clone()
        .json()
        .catch(() => null)) as { error?: unknown; deletedLines?: unknown } | null;
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, tBanking("errors.requestFailed")));
        return;
      }
      toast.success(
        t("importDeleted", {
          count: typeof data?.deletedLines === "number" ? data.deletedLines : lineCount,
        }),
      );
      router.refresh();
    } catch {
      toast.error(tBanking("errors.requestFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={busy}
      title={t("deleteImport")}
      aria-label={t("deleteImport")}
      onClick={run}
    >
      <Trash2 size={14} />
    </Button>
  );
}
