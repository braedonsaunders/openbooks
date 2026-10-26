import { toast } from "sonner";
import { fetchAppAction } from "../lib/api-error";
import { confirmDialog } from "../lib/confirm";
import { promptDialog } from "../lib/prompt";
import { promptVoidReversalPeriod } from "../lib/void-reversal-period";
import { parseTenderDrafts } from "./cash-tenders-section";
import type { DocumentDrawerPayloadScope } from "./document-drawer-payload";

/**
 * Lifecycle commands on a saved record: submit, post, retry, draft, delete,
 * void, and the preferred form. Split from the command module so each module
 * stays within the line bound.
 */
export function buildDocumentDrawerLifecycleCommands(scope: DocumentDrawerPayloadScope) {
  const {
    basePath,
    blockCurrencyMismatch,
    customValues,
    doc,
    documentRevision,
    effectiveTotals,
    execute,
    isCashKind,
    money,
    recordType,
    refuse,
    router,
    setMatchRefused,
    setPostWarnings,
    t,
    tCommon,
    tPostingEffects,
    tenderAccountOptions,
  } = scope;
  async function act(action: "submit" | "post") {
    // Same up-front refusal as save: posting a currency-mismatched record
    // is a certain 422, so name the account before the round trip.
    if (blockCurrencyMismatch()) {
      return;
    }
    // Consequence before commit for till money: state in plain words what
    // posting settles — per tender account — before the kernel runs. The
    // section above already cross-foots tendered against the total; this
    // restates it at the commit point so a mis-tendered tap cannot slip
    // through on muscle memory.
    if (action === "post" && isCashKind) {
      const drafts = parseTenderDrafts(customValues.tenders);
      const tenderLines = drafts.map((draft) => {
        const label = draft.methodLabel || draft.kind;
        const reference = draft.reference ? ` ${draft.reference}` : "";
        if (draft.kind === "stored_value") {
          const card = draft.svLast4 ? `…${draft.svLast4}` : t("tenders.unresolvedCard");
          return `· ${money(draft.amount || "0", { currency: doc.currency })} ${label}${reference} → ${card}`;
        }
        const account =
          tenderAccountOptions.find((option) => option.value === draft.accountId)?.label ??
          draft.accountId;
        return `· ${money(draft.amount || "0", { currency: doc.currency })} ${label}${reference} → ${account}`;
      });
      const confirmed = await confirmDialog({
        title: t("tenders.postTitle"),
        message: t("tenders.postBody", {
          number: doc.document_number ?? "",
          total: money(effectiveTotals.total, { currency: doc.currency }),
          tenders: tenderLines.join("\n"),
        }),
        confirmLabel: tCommon("actions.post"),
      });
      if (!confirmed) return;
    }
    setPostWarnings([]);
    setMatchRefused(false);
    await execute(
      () =>
        fetchAppAction(
          "/api/documents/actions",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, documentId: doc.id }),
          },
          { fallback: t("toasts.actionFailed") },
        ),
      {
        fallbackMessage: t("toasts.actionFailed"),
        onOk: (data) => {
          const result = data as {
            pendingApproval?: unknown;
            warnings?: {
              code: string;
              accounts?: { accountNumber: string | null; accountName: string }[];
            }[];
          } | null;
          const pendingApproval = result?.pendingApproval === true;
          if (pendingApproval) toast.success(t("toasts.submitted"));
          else toast.success(action === "submit" ? t("toasts.submitted") : t("toasts.posted"));
          const partyless = (result?.warnings ?? []).find(
            (warning) => warning.code === "partyless_control_lines",
          );
          if (partyless?.accounts?.length) {
            setPostWarnings([
              t("drawer.partylessControlWarning", {
                accounts: partyless.accounts
                  .map((account) => `${account.accountNumber ?? ""} ${account.accountName}`.trim())
                  .join(", "),
              }),
            ]);
          }
          router.refresh();
        },
        onRefused: (error) => {
          // Lifecycle refusals (period locks, missing control accounts,
          // kernel guards) must stay visible in the drawer: a transient
          // toast alone is too easy to miss, so the message also pins as an
          // inline banner until the next action or edit. A rejected transport
          // pins without refreshing — there is nothing new to show.
          // A bill refused until its lines are matched offers the match
          // dialog beside the pinned refusal, keyed on the refusal code —
          // never on message text.
          if (error.code === "BILL_LINES_UNMATCHED") setMatchRefused(true);
          if (error.kind !== "transport") router.refresh();
        },
      },
    );
  }

  async function retryPostingEffects() {
    const reason = await promptDialog({
      title: tPostingEffects("retry"),
      label: tPostingEffects("reason"),
      placeholder: tPostingEffects("reasonHelp"),
    });
    if (reason === null) return;
    if (reason.trim().length < 10 || reason.trim().length > 1000) {
      refuse(tPostingEffects("reasonHelp"), t("toasts.actionFailed"));
      return;
    }
    await execute(
      () =>
        fetchAppAction(
          "/api/documents/actions",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "retry-effects", documentId: doc.id, reason }),
          },
          { fallback: t("toasts.actionFailed") },
        ),
      {
        fallbackMessage: t("toasts.actionFailed"),
        successMessage: tPostingEffects("queued"),
        onOk: () => router.refresh(),
      },
    );
  }

  async function returnToDraft() {
    // A mis-approved document corrects through edit and re-approval, never
    // through a void on a record that never touched the GL. The server owns
    // the approved-only gate, the approve-level permission, and every refusal
    // remedy; refusals pin beside the record through the shared handler.
    const reason = await promptDialog({
      title: tCommon("actions.returnToDraft"),
      label: tCommon("amendment.reason"),
      placeholder: tCommon("amendment.returnToDraftPlaceholder"),
      confirmLabel: tCommon("actions.returnToDraft"),
    });
    if (reason === null) return;
    if (reason.trim().length < 5 || reason.trim().length > 500) {
      refuse(tCommon("amendment.returnToDraftPlaceholder"), t("toasts.actionFailed"));
      return;
    }
    await execute(
      () =>
        fetchAppAction(
          "/api/documents/actions",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "return_to_draft",
              documentId: doc.id,
              reason,
              expectedUpdatedAt: documentRevision,
            }),
          },
          { fallback: t("toasts.actionFailed") },
        ),
      {
        fallbackMessage: t("toasts.actionFailed"),
        successMessage: tCommon("status.draft"),
        onOk: () => router.refresh(),
      },
    );
  }

  async function remove() {
    if (
      !(await confirmDialog({
        title: t("drawer.deleteTitle"),
        message: t("drawer.deleteDraftBody"),
        confirmLabel: tCommon("actions.delete"),
        tone: "danger",
      }))
    )
      return;
    await execute(
      () =>
        fetchAppAction(
          `/api/documents/${doc.id}`,
          {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ expectedUpdatedAt: documentRevision }),
          },
          { fallback: t("toasts.deleteFailed") },
        ),
      {
        fallbackMessage: t("toasts.deleteFailed"),
        successMessage: t("toasts.deleted"),
        onOk: () => {
          router.push(basePath);
          router.refresh();
        },
      },
    );
  }

  async function voidDocument() {
    const reason = await promptDialog({
      title: tCommon("amendment.voidTitle"),
      label: tCommon("amendment.reason"),
      placeholder: tCommon("amendment.voidPlaceholder"),
      confirmLabel: tCommon("actions.void"),
    });
    if (!reason) return;
    const reversal = await promptVoidReversalPeriod(doc.id, {
      title: tCommon("amendment.voidReversalPeriodTitle"),
      dateLabel: tCommon("amendment.voidReversalDateLabel"),
      summaryOriginal: tCommon("amendment.voidReversalSummaryOriginal"),
      summaryReversal: tCommon("amendment.voidReversalSummaryReversal"),
      fiscalYear: tCommon("amendment.voidReversalFiscalYear"),
      fallbackNotice: tCommon("amendment.voidReversalFallbackNotice"),
      closedNotice: tCommon("amendment.voidReversalClosedNotice"),
      label: tCommon("amendment.voidReversalPeriodLabel"),
      regularOption: tCommon("amendment.voidReversalPeriodRegular"),
      confirm: tCommon("actions.void"),
      cancel: tCommon("confirm.cancel"),
    });
    if (reversal.cancelled) return;
    await execute(
      () =>
        // The enriched read keeps the server's remedy and code on the
        // refusal: a void the periods or approvals refuse pins its reason
        // and next step, never a bare fallback.
        fetchAppAction(
          `/api/documents/${doc.id}/void`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              reason,
              expectedUpdatedAt: documentRevision,
              ...(reversal.reversalDate ? { reversalDate: reversal.reversalDate } : {}),
              ...(reversal.reversalPeriodId ? { reversalPeriodId: reversal.reversalPeriodId } : {}),
            }),
          },
          { fallback: t("toasts.actionFailed") },
        ),
      {
        fallbackMessage: t("toasts.actionFailed"),
        onOk: (data) => {
          const status = (data as { status?: unknown } | null)?.status;
          if (status === "pending_approval") toast.success(t("toasts.submitted"));
          else toast.success(tCommon("status.voided"));
        },
      },
    );
    router.refresh();
  }

  // Per-record "Custom Form" picker (view mode) — switch the form layout for
  // this record, optionally set it as the user's preferred form.
  async function setPreferredForm(layoutId: string | null) {
    if (!recordType) return;
    await execute(
      () =>
        fetchAppAction(
          "/api/customization/form-preferences",
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ recordType, layoutId }),
          },
          { fallback: t("drawer.formPreferredFailed") },
        ),
      {
        fallbackMessage: t("drawer.formPreferredFailed"),
        successMessage: layoutId
          ? t("drawer.formSetPreferredDone")
          : t("drawer.formPreferredCleared"),
      },
    );
  }
  return {
    act,
    retryPostingEffects,
    returnToDraft,
    remove,
    voidDocument,
    setPreferredForm,
  };
}
