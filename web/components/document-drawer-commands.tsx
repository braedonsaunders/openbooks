import Link from "next/link";
import { toast } from "sonner";

import { ActionError } from "@braedonsaunders/appkit-errors";

import { fetchAppAction } from "../lib/api-error";

import { confirmDialog } from "../lib/confirm";

import { previewPostedCorrection } from "../lib/posted-correction-preview";

import { promptDialog } from "../lib/prompt";

import { runClientScripts } from "../lib/client-scripts";

import { documentCreateHref, isDocumentCreateKind } from "../lib/document-kinds";

import type { DocPayload } from "./document-drawer-types";

import { findMissingAccountLine, positiveAmount } from "./document-drawer-lines";

import {
  buildDocumentCreateRequest,
  buildDocumentSaveRequest,
  buildReturnCreateRequest,
  createdDocumentId,
  editedDocumentAcknowledged,
  reconcilePersistedDocumentSnapshot,
  revisionFromSuccessfulDocumentSave,
  type DocumentSaveRequest,
} from "./document-drawer-save";

import type { DocumentDrawerPayloadScope } from "./document-drawer-payload";

import { buildDocumentDrawerLifecycleCommands } from "./document-drawer-lifecycle-commands";

/**
 * The drawer's write paths: save (create, edit, posted correction), cancel
 * and discard, lifecycle actions, retries, delete, void, and the preferred
 * form. Every write runs on the shared action path from the scope.
 */
/**
 * Where a successful save lands: the saved record in view mode, a fresh
 * create form for the same kind, or the list the drawer opened from. `post`
 * and `postNew` continue through the native atomic post command; an approval Flow that gates the record
 * leaves it pending approval, exactly as Submit would.
 */
export type DocumentSaveThen = "view" | "new" | "close" | "post" | "postNew";

export function buildDocumentDrawerCommands(
  scope: DocumentDrawerPayloadScope,
  { startFresh }: { startFresh?: () => void } = {},
) {
  const tEntry = scope.tEntry;
  const {
    isCreate,
    canCreate,
    config,
    partyId,
    documentDate,
    effectiveTotals,
    referenceNumber,
    t,
    tCommon,
    hrefForDocument,
    isPosted,
    doc,
    payload,
    payload_,
    persistedBaseline,
    persistedPropRevision,
    seenPersistedRevisions,
    documentRevision,
    setDocumentRevision,
    setSaveState,
    refuse,
    execute,
    runExclusive,
    blockCurrencyMismatch,
    rows,
    idempotencyKey,
    router,
    basePath,
    searchParams,
    resetForm,
    mode,
    setMode,
    dirty,
    setDirty,
    money,
    canPost,
    stashCarry,
    controlMismatch,
    controlDifference,
    controlInvalid,
  } = scope;

  // Confirm-before-save duplicate warning for new invoices and bills: a
  // non-voided same-kind document for the same party, date and total (plus
  // the vendor reference for bills) is usually a double entry. A warning,
  // never a refusal — confirming saves anyway. An unreadable probe fails
  // open: the save itself stays server-validated, so a down lookup must not
  // block persistence.
  async function confirmNoDuplicate(): Promise<boolean> {
    if (
      !isCreate ||
      (config.kind !== "customer_invoice" &&
        config.kind !== "vendor_bill" &&
        config.kind !== "vendor_credit")
    )
      return true;
    if (!partyId || !documentDate || !positiveAmount(effectiveTotals.total)) return true;
    const query = new URLSearchParams({
      kind: config.kind,
      partyId,
      documentDate,
      total: effectiveTotals.total,
    });
    if (
      (config.kind === "vendor_bill" || config.kind === "vendor_credit") &&
      referenceNumber.trim()
    ) {
      query.set("referenceNumber", referenceNumber.trim());
    }
    let duplicates: { id: string; documentNumber: string; reason?: string }[] = [];
    try {
      const response = await fetch(`/api/documents/duplicates?${query.toString()}`);
      if (!response.ok) return true;
      duplicates =
        ((await response.json()) as { duplicates?: { id: string; documentNumber: string }[] })
          .duplicates ?? [];
    } catch {
      return true;
    }
    if (duplicates.length === 0) return true;
    const [first, ...rest] = duplicates;
    return confirmDialog({
      title: t("drawer.duplicateTitle"),
      message: (
        <>
          <p>
            {t("drawer.duplicateBody", {
              numbers: duplicates.map((match) => match.documentNumber).join(", "),
            })}
          </p>
          {first ? (
            <p className="mt-2">
              <Link
                className="text-teal-700 hover:underline dark:text-teal-300"
                href={hrefForDocument(first.id)}
              >
                {t("drawer.duplicateOpen", { number: first.documentNumber })}
              </Link>
              {rest.length > 0 ? ` · +${rest.length}` : null}
            </p>
          ) : null}
        </>
      ),
      confirmLabel: t("drawer.duplicateConfirm"),
      // A reflexive Enter must not book a second copy of a bill.
      defaultAction: "cancel",
    });
  }

  // Re-entry runs through the shared guard: save awaits the client-script
  // gate (up to 2 s) before execute sets busy, so a double-click used to
  // send two saves with the same revision — the second 409ing after the
  // first succeeded and pinning its error over the success. The guard flips
  // synchronously at click time and covers the whole preamble.
  // The save preamble — posted-edit dialogs, client-script and form gates,
  // the duplicate probe, and both request builders — runs outside the fenced
  // execute below. A throw in any of them used to escape as an unhandled
  // rejection: no record, no message, and the form wedged on Saving. The
  // preamble returns the fenced request to write, or 'aborted' for an
  // operator cancellation (which stays silent, exactly as today).
  async function prepareSaveRequest(): Promise<
    | {
        outcome: "create";
        request: {
          path: string;
          method: "POST";
          headers: Record<string, string>;
          body: Record<string, unknown>;
        };
      }
    | { outcome: "save"; request: DocumentSaveRequest }
    | { outcome: "aborted" }
  > {
    let amendmentReason: string | undefined;
    if (isPosted) {
      const reason = await promptDialog({
        title: tCommon("amendment.title"),
        label: tCommon("amendment.reason"),
        placeholder: tCommon("amendment.placeholder"),
        confirmLabel: tCommon("actions.save"),
      });
      if (!reason) return { outcome: "aborted" as const };
      amendmentReason = reason;
      // A posted edit states its consequence before anything writes, using
      // the same engine classification the correct route enforces. A void
      // and reissue needs an explicit confirm; metadata and reclass confirm
      // the lighter touch in the same step.
      const consequence = previewPostedCorrection({
        doc,
        storedLines: persistedBaseline.current.payload.lines ?? [],
        payload: payload_ as Record<string, unknown>,
      });
      const confirmed = await confirmDialog({
        title: tCommon("amendment.consequenceTitle"),
        message:
          consequence === "void-and-reissue"
            ? tCommon("amendment.consequenceVoid")
            : consequence === "reclass"
              ? tCommon("amendment.consequenceReclass")
              : tCommon("amendment.consequenceMetadata"),
        confirmLabel: tCommon("actions.save"),
        ...(consequence === "void-and-reissue" ? { tone: "danger" as const } : {}),
      });
      if (!confirmed) return { outcome: "aborted" as const };
    }
    setSaveState("saving");
    // Client scripts (sandboxed, opaque-origin evaluator) gate the save: an
    // explicit { abort } blocks; { warnings } toast and proceed; fail-open.
    const gate = await runClientScripts(config.kind, payload_);
    if (!gate.ok) {
      refuse(gate.reason, t("toasts.actionFailed"));
      setSaveState("error");
      return { outcome: "aborted" as const };
    }
    for (const w of gate.warnings) toast.warning(w);
    // A currency-mismatched form can never post (the ledger refuses it), so
    // refuse the save up front with the account named.
    if (blockCurrencyMismatch()) {
      setSaveState("error");
      return { outcome: "aborted" as const };
    }
    // A contentful row without an account can never book either: the
    // server names the line and refuses. Refuse up front with the grid
    // line named and keep every entered row in place — dropping the row
    // here used to book a total the operator never reviewed.
    // A control total keyed from the vendor's document must equal the lines
    // before anything saves; the difference is named so the clerk knows
    // which way the lines are off.
    if (controlInvalid) {
      refuse(tEntry("controlTotal.invalid"), t("toasts.actionFailed"));
      setSaveState("error");
      return { outcome: "aborted" as const };
    }
    if (controlMismatch && controlDifference !== null) {
      refuse(
        tEntry("controlTotal.mismatch", {
          difference: money(controlDifference, { currency: doc.currency }),
        }),
        t("toasts.actionFailed"),
      );
      setSaveState("error");
      return { outcome: "aborted" as const };
    }
    const missingAccount = findMissingAccountLine(rows);
    if (missingAccount) {
      refuse(
        t("drawer.lineMissingAccount", { line: missingAccount.lineNumber }),
        t("toasts.actionFailed"),
      );
      setSaveState("error");
      return { outcome: "aborted" as const };
    }
    // Unsaved create: the single collection write. Same client-script and
    // currency gates as an edit above; the server runs the shared writer, so
    // validation, refusals, and audit match an edit exactly.
    if (isCreate) {
      // A possible duplicate warns before the write, never instead of it:
      // declining leaves the form exactly as typed for review.
      if (!(await confirmNoDuplicate())) {
        setSaveState("dirty");
        return { outcome: "aborted" as const };
      }
      if (config.kind === "rma") {
        return {
          outcome: "create" as const,
          request: buildReturnCreateRequest(payload_ as Record<string, unknown>, idempotencyKey),
        };
      }
      return {
        outcome: "create" as const,
        request: buildDocumentCreateRequest(
          config.kind,
          payload_ as Record<string, unknown>,
          idempotencyKey,
        ),
      };
    }
    return {
      outcome: "save" as const,
      request: buildDocumentSaveRequest(
        String(doc.id),
        documentRevision,
        payload_,
        isPosted,
        amendmentReason,
      ),
    };
  }

  // Save & new needs an unsaved create form for this kind; kinds without one
  // (and readers who may not create) save to the record instead.
  const freshFormHref =
    canCreate && isDocumentCreateKind(config.kind)
      ? documentCreateHref(basePath, config.kind)
      : null;

  /**
   * Leave a saved record for the requested destination. A fresh form for
   * the kind already open in create mode has the same URL, so the drawer
   * remounts to drop the saved entries and the spent idempotency key.
   */
  function landAfterSave(then: DocumentSaveThen, recordHref: string) {
    if ((then === "new" || then === "postNew") && freshFormHref) {
      stashCarry();
      router.push(freshFormHref);
      if (isCreate) startFresh?.();
    } else if (then === "close") {
      router.push(basePath);
    } else {
      router.push(recordHref);
    }
    router.refresh();
  }

  /** The native post command submits drafts, honors approval Flows and posts atomically. */
  async function postSaved(
    documentId: string,
    documentNumber: string,
  ): Promise<"posted" | "pending" | "refused"> {
    const result: { outcome: "posted" | "pending" | "refused" } = { outcome: "refused" };
    await execute(
      () =>
        fetchAppAction(
          "/api/documents/actions",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "post", documentId }),
          },
          { fallback: t("toasts.actionFailed") },
        ),
      {
        fallbackMessage: t("toasts.actionFailed"),
        onOk: (data) => {
          result.outcome =
            (data as { pendingApproval?: unknown } | null)?.pendingApproval === true
              ? "pending"
              : "posted";
          toast.success(
            tEntry(
              result.outcome === "pending" ? "postAfterSave.pending" : "postAfterSave.posted",
              { number: documentNumber },
            ),
          );
        },
      },
    );
    return result.outcome;
  }

  const save = runExclusive(async (then: DocumentSaveThen = "view") => {
    const postContinuation: { run?: () => Promise<void> } = {};
    // Copy for a save the server failed to answer; a reason the server named
    // still pins verbatim, and only this exact copy marks the footer state.
    const unavailableCopy = t("drawer.saveState.unavailableDetail");
    let prepared: Awaited<ReturnType<typeof prepareSaveRequest>>;
    try {
      prepared = await prepareSaveRequest();
    } catch (error) {
      // Preamble bugs surface exactly like a refused save — pinned beside
      // the record and toasted — never a wedged Saving state with no
      // message. The operator reads the localized fallback (a client
      // exception is never usable copy); the console keeps the bug text.
      console.error("[document-drawer] save preamble failed", error);
      refuse(null, t("toasts.actionFailed"));
      setSaveState("error");
      return;
    }
    if (prepared.outcome === "aborted") return;
    if (prepared.outcome === "create") {
      const create = prepared.request;
      await execute(
        async () => {
          const result = await fetchAppAction(
            create.path,
            {
              method: create.method,
              headers: create.headers,
              body: JSON.stringify(create.body),
            },
            {
              fallback: t("toasts.actionFailed"),
              unavailable: unavailableCopy,
              codeMessage: (code) =>
                code === "document_create_conflict" ? t("drawer.createConflict") : undefined,
            },
          );
          // A success that names no record is not a saved document: refuse it
          // here so the drawer neither toasts nor navigates on it. The key is
          // kept, so a retry replays the same record instead of duplicating it.
          if (!result.ok || createdDocumentId(result.data) !== null) return result;
          return {
            ok: false,
            error: new ActionError({
              kind: "refused",
              serverMessage: t("drawer.createUnconfirmed"),
            }),
          };
        },
        {
          fallbackMessage: t("toasts.actionFailed"),
          onOk: (payload) => {
            const saved = (payload as DocPayload).doc;
            const recordHref = `${basePath}?doc=${String(saved.id)}`;
            if (then === "post" || then === "postNew") {
              postContinuation.run = () =>
                postSavedThenLand(
                  String(saved.id),
                  String(saved.document_number ?? ""),
                  then,
                  recordHref,
                );
              return;
            }
            toast.success(
              t("toasts.saved", { documentNumber: String(saved.document_number ?? "") }),
            );
            // Land on the persisted record in view mode: the changed drawer
            // id remounts clean, so Submit/Post is available at once instead
            // of needing a second save to leave the editing caption behind.
            landAfterSave(then, recordHref);
          },
          onRefused: (error) => {
            setSaveState(error.serverMessage === unavailableCopy ? "unavailable" : "error");
          },
        },
      );
      await postContinuation.run?.();
      return;
    }
    const request = prepared.request;
    await execute(
      async () => {
        const result = await fetchAppAction(
          request.path,
          {
            method: request.method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(request.body),
          },
          { fallback: t("toasts.actionFailed"), unavailable: unavailableCopy },
        );
        // An edit that does not name its record and revision cannot be adopted:
        // refuse it here instead of failing silently inside onOk.
        if (!result.ok || editedDocumentAcknowledged(result.data)) return result;
        return {
          ok: false,
          error: new ActionError({ kind: "refused", serverMessage: t("drawer.saveUnconfirmed") }),
        };
      },
      {
        // A fresh attempt clears the previous refusal: the alert pins until
        // the next action, not past a successful save.
        fallbackMessage: t("toasts.actionFailed"),
        onOk: (payload) => {
          const data = payload as DocPayload & {
            correctionId?: string;
            voidStatus?: "voided" | "pending_approval" | "corrected" | "reclassified";
          };
          if (isPosted && data.correctionId) {
            // In-place corrections keep the source document: toast the
            // lighter touch and refresh where the operator stands instead
            // of navigating to a replacement draft that does not exist.
            if (data.voidStatus === "corrected" || data.voidStatus === "reclassified") {
              toast.success(tCommon("amendment.correctionApplied"));
              router.refresh();
              return;
            }
            toast.success(
              data.voidStatus === "pending_approval"
                ? t("toasts.submitted")
                : tCommon("amendment.correctionCreated"),
            );
            router.push(hrefForDocument(data.correctionId));
            router.refresh();
            return;
          }
          const savedRevision = revisionFromSuccessfulDocumentSave(data);
          persistedBaseline.current = {
            documentId: String(data.doc.id),
            revision: savedRevision,
            payload: data,
          };
          seenPersistedRevisions.current.add(savedRevision);
          resetForm(data);
          setDocumentRevision(savedRevision);
          setSaveState("saved");
          setDirty(false);
          setMode("view");
          const recordHref = hrefForDocument(
            String(data.doc.id),
            searchParams.get("form") ?? undefined,
          );
          if (
            (then === "post" || then === "postNew") &&
            (data.doc.status === "draft" || data.doc.status === "approved")
          ) {
            postContinuation.run = () =>
              postSavedThenLand(
                String(data.doc.id),
                String(data.doc.document_number ?? ""),
                then,
                recordHref,
              );
            return;
          }
          toast.success(
            t("toasts.saved", { documentNumber: String(data.doc.document_number ?? "") }),
          );
          // The save consumes the explicit edit request: landing on the
          // mode-less record URL keeps a later reload in view mode instead
          // of resurrecting the editing caption with nothing to save.
          landAfterSave(then === "post" ? "view" : then === "postNew" ? "new" : then, recordHref);
        },
        onRefused: (error) => {
          // A save refusal stays on the record, not only in a toast:
          // the typed reason pins as an alert until the next action or edit.
          // A server or connection failure with no named reason keeps the
          // entered values and says so, so the footer must not call it a refusal.
          setSaveState(error.serverMessage === unavailableCopy ? "unavailable" : "error");
        },
      },
    );
    await postContinuation.run?.();
  });

  /** After a save that asked to post: run the lifecycle, then land. */
  function postSavedThenLand(
    documentId: string,
    documentNumber: string,
    then: "post" | "postNew",
    recordHref: string,
  ) {
    return postSaved(documentId, documentNumber).then((outcome) => {
      // A refused post stays on the saved draft so the pinned reason is read.
      if (outcome === "refused") {
        router.push(recordHref);
        router.refresh();
        return;
      }
      landAfterSave(then === "postNew" ? "new" : "view", recordHref);
    });
  }

  /** Posting from the drawer is offered where the record could be posted directly after saving. */
  const canSaveAndPost = canPost && config.kind !== "project_charge" && config.directPost !== true;

  // A dirty editor never closes silently: the X button (via beforeClose) and
  // Cancel both ask first, so typed work survives a stray click.
  async function confirmDiscard() {
    if (mode !== "edit" || !dirty) return true;
    return confirmDialog({
      message: tCommon("feedback.unsavedChanges"),
      confirmLabel: tCommon("confirm.discardChanges"),
      tone: "danger",
    });
  }

  async function cancelWithConfirm() {
    if (!(await confirmDiscard())) return;
    cancel();
  }

  function cancel() {
    // Unsaved create holds no persisted state to restore: closing navigates
    // away and writes nothing — zero writes by construction (the only write
    // this drawer can make is the Save POST above, which Cancel never runs).
    if (isCreate) {
      router.push(basePath);
      router.refresh();
      return;
    }
    const incoming = {
      documentId: String(doc.id),
      revision: persistedPropRevision,
      payload,
    };
    const previousDocumentId = persistedBaseline.current.documentId;
    const previouslySeen = new Set(seenPersistedRevisions.current);
    const decision = reconcilePersistedDocumentSnapshot(
      persistedBaseline.current,
      incoming,
      false,
      previouslySeen,
    );
    if (previousDocumentId !== incoming.documentId) {
      seenPersistedRevisions.current = new Set([persistedPropRevision]);
    } else if (decision.rehydrate) {
      seenPersistedRevisions.current.add(persistedPropRevision);
    }
    persistedBaseline.current = decision.snapshot;
    resetForm(decision.snapshot.payload);
    setDocumentRevision(decision.snapshot.revision);
    setDirty(false);
    setSaveState("saved");
    setMode("view");
  }

  const { act, retryPostingEffects, returnToDraft, remove, voidDocument, setPreferredForm } =
    buildDocumentDrawerLifecycleCommands(scope);

  return {
    save,
    canSaveAndPost,
    freshFormHref,
    confirmDiscard,
    cancelWithConfirm,
    act,
    retryPostingEffects,
    returnToDraft,
    remove,
    voidDocument,
    setPreferredForm,
  };
}

export type DocumentDrawerCommandsScope = DocumentDrawerPayloadScope &
  ReturnType<typeof buildDocumentDrawerCommands>;
