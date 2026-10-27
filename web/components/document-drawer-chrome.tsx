import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { Button, Select } from "@openbooks/ui";
import { displayDocumentNumber, displayFormName } from "../lib/document-display";
import {
  documentActionAvailable,
  type DocumentLifecycleAction,
} from "../lib/document-action-availability";
import { PDF_RECORD_TYPE_BY_KEY } from "../lib/pdf-templates/catalog";
import { FORM_ACTION_KEYS } from "@openbooks/customization";
import { TransactionDrawer } from "./transaction-drawer";
import { CashTendersSection } from "./cash-tenders-section";
import { CashDepositSection } from "./cash-deposit-section";
import { docTypeMeta } from "./doc-type-badge";
import { JournalEntryLink } from "./journal-entry-link";
import { PdfButton } from "./pdf-button";
import { EInvoiceButton } from "./einvoice-button";
import { SendButton } from "./send-button";
import { FlowManualButtons } from "./flow-manual-buttons";
import { ApprovalActions } from "./approval-actions";
import { FormShortcuts } from "./shortcuts/form-shortcuts";
import { DocumentDrawerTitle, STATUS_KEYS, STATUS_VARIANT } from "./document-drawer-title";
import { positiveAmount } from "./document-drawer-lines";
import type { DocumentDrawerHeaderScope } from "./document-drawer-header";

/**
 * The drawer shell around the record body: title, primary and menu actions,
 * the cash tenders tab, and the save-state/totals footer.
 */
export function renderDocumentDrawerChrome(scope: DocumentDrawerHeaderScope, children: ReactNode) {
  const {
    config,
    t,
    tCommon,
    tReturns,
    tPostingEffects,
    money,
    router,
    basePath,
    hrefForDocument,
    doc,
    currency,
    isDraft,
    isPosted,
    isCreate,
    isCashKind,
    isTransfer,
    canCreate,
    canPost,
    canEditStatus,
    canCustomize,
    canDeposit,
    editable,
    mode,
    setMode,
    displayStatus,
    busy,
    dirty,
    saveState,
    partyId,
    documentDate,
    subsidiaryId,
    effectiveTotals,
    calculatedTotals,
    nativeGoods,
    layout,
    availableLayouts,
    currentLayoutId,
    recordType,
    customValues,
    setCustomValues,
    tenderAccounts,
    tenderAccountOptions,
    defaultTenderAccountId,
    storedValueEnabled,
    resolveStoredValueCode,
    serverOptions,
    tillSuggestion,
    cashSourceOptions,
    depositDefaultDate,
    depositAccountOptions,
    returnAuthorizationHref,
    settlementHref,
    refundHref,
    creditHref,
    submitRoutesForApproval,
    save,
    canSaveAndPost,
    freshFormHref,
    tEntry,
    controlTotal,
    setControlTotal,
    controlDifference,
    controlMismatch,
    cancelWithConfirm,
    confirmDiscard,
    act,
    voidDocument,
    remove,
    retryPostingEffects,
    returnToDraft,
    setPreferredForm,
  } = scope;

  const showFormPicker =
    !editable && !!availableLayouts && availableLayouts.length > 0 && !!recordType;

  // Deep link into the form designer for this record type — straight to the
  // active layout when one is applied, otherwise the record type's forms tab.
  const customizeHref =
    canCustomize && recordType
      ? `/admin/customization?recordType=${encodeURIComponent(recordType)}&tab=forms${currentLayoutId ? `&form=${currentLayoutId}` : ""}`
      : null;

  const actionLayout = layout?.actions ?? FORM_ACTION_KEYS.map((key) => ({ key, visible: true }));
  // The 'hide Edit' form-layout action governs the primary Edit button too,
  // not just the actions menu (which already filters 'edit' out): saving the
  // toggle must remove every Edit entry point.
  const editActionVisible = actionLayout.find((action) => action.key === "edit")?.visible !== false;
  // Lifecycle entries in the actions menu read one availability rule: a posted
  // record offers only its governed void (see document-action-availability).
  const lifecycleAction = (action: DocumentLifecycleAction) =>
    documentActionAvailable(action, {
      status: doc.status,
      directPost: config.directPost === true,
      canCreate,
      canPost,
    });
  const layoutShows = (key: string) =>
    actionLayout.find((action) => action.key === key)?.visible !== false;
  const nextStepAction =
    mode === "edit"
      ? null
      : layoutShows("post") && lifecycleAction("post")
        ? "post"
        : layoutShows("submit") && lifecycleAction("submit")
          ? "submit"
          : null;
  // The header shows a saved record's next lifecycle step as its own button,
  // so posting or submitting never hides behind the Actions menu.
  const compactAction = "h-8 px-2.5 text-xs";
  const renderFormAction = (key: string, placement: "menu" | "header" = "menu") => {
    switch (key) {
      case "customize":
        return customizeHref ? (
          <Button variant="ghost" asChild>
            <Link href={customizeHref}>{tCommon("actions.customize")}</Link>
          </Button>
        ) : null;
      case "pdf":
        return PDF_RECORD_TYPE_BY_KEY[recordType ?? String(doc.kind)] ? (
          <Fragment>
            <PdfButton recordType={recordType ?? String(doc.kind)} recordId={String(doc.id)} />
            {(doc.kind === "customer_invoice" || doc.kind === "customer_credit") && isPosted && (
              <EInvoiceButton documentId={String(doc.id)} />
            )}
          </Fragment>
        ) : null;
      case "workflow":
        return <FlowManualButtons subjectKind={String(doc.kind)} subjectId={String(doc.id)} />;
      case "approval":
        return (
          <ApprovalActions
            subjectKind={String(doc.kind)}
            subjectId={String(doc.id)}
            withdraw={{
              documentId: String(doc.id),
              status: doc.status,
              canCreate,
              canApprove: canPost,
            }}
          />
        );
      case "submit":
        return lifecycleAction("submit") ? (
          <Button
            size={placement === "header" ? "sm" : undefined}
            className={placement === "header" ? compactAction : undefined}
            disabled={
              busy ||
              (config.partyRole ? !partyId : false) ||
              !positiveAmount(effectiveTotals.total)
            }
            onClick={() => act("submit")}
          >
            {submitRoutesForApproval === false
              ? tCommon("actions.approve")
              : t("actions.submitForApproval")}
          </Button>
        ) : null;
      case "post":
        return lifecycleAction("post") ? (
          <Button
            size={placement === "header" ? "sm" : undefined}
            className={placement === "header" ? compactAction : undefined}
            disabled={busy || (isDraft && !positiveAmount(effectiveTotals.total))}
            onClick={() => act("post")}
          >
            {tCommon("actions.post")}
          </Button>
        ) : null;
      case "void":
        return lifecycleAction("void") ? (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={voidDocument}
            className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            {tCommon("actions.void")}
          </Button>
        ) : null;
      case "gl_impact":
        return doc.entry_id ? (
          <Button variant="outline" asChild>
            <JournalEntryLink entryId={doc.entry_id}>{t("drawer.viewGlImpact")}</JournalEntryLink>
          </Button>
        ) : null;
      case "delete":
        return lifecycleAction("delete") ? (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={remove}
            className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            {tCommon("actions.delete")}
          </Button>
        ) : null;
      default:
        return null;
    }
  };

  return (
    <TransactionDrawer
      closeHref={basePath}
      beforeClose={confirmDiscard}
      recordId={String(doc.id)}
      keepRecordTabsMounted={isCashKind}
      detailTabs={
        isCashKind && tenderAccounts
          ? [
              {
                key: "tenders",
                label: t("tenders.title"),
                content: (
                  <>
                    <CashTendersSection
                      value={customValues.tenders}
                      onChange={(next) => setCustomValues((c) => ({ ...c, tenders: next }))}
                      editable={editable}
                      total={effectiveTotals.total}
                      currency={doc.currency}
                      accountOptions={tenderAccountOptions}
                      defaultAccountId={defaultTenderAccountId}
                      storedValueEnabled={storedValueEnabled}
                      resolveStoredValueCode={resolveStoredValueCode}
                      closeoutValue={customValues.closeout}
                      onCloseoutChange={
                        editable
                          ? (next) => setCustomValues((c) => ({ ...c, closeout: next }))
                          : undefined
                      }
                      serverOptions={serverOptions}
                      tillSuggestion={tillSuggestion}
                    />
                    {/* Till drop beside the settled cash: the drop records against
                the till and date, covering every sale in its window; a
                posted sale may instead drop exactly its own cash.
                Without the deposit grant the surface names the permission
                instead of hiding, so the operator learns the next step. */}
                    {config.kind === "cash_sale" &&
                    (isPosted ||
                      (!isCreate && doc.status !== "voided" && cashSourceOptions.length > 0)) ? (
                      canDeposit ? (
                        <CashDepositSection
                          saleId={String(doc.id)}
                          currency={doc.currency}
                          defaultDate={depositDefaultDate || documentDate || ""}
                          bankOptions={depositAccountOptions}
                          sourceOptions={cashSourceOptions}
                          subsidiaryId={subsidiaryId || null}
                          mode={cashSourceOptions.length > 0 ? "till" : "sale"}
                          modes={
                            isPosted
                              ? cashSourceOptions.length > 0
                                ? ["till", "sale"]
                                : ["sale"]
                              : ["till"]
                          }
                        />
                      ) : (
                        <p className="border-t border-slate-200 pt-3 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
                          {t("tenders.depositRequiresPermission")}
                        </p>
                      )
                    ) : null}
                  </>
                ),
              },
            ]
          : []
      }
      showEvidenceTabs={!isCreate}
      canEditAttachments={isCreate ? false : canCreate}
      panelClassName={docTypeMeta(config.kind).surfaceCls}
      title={
        <DocumentDrawerTitle
          kind={config.kind}
          documentNumber={displayDocumentNumber(doc.document_number, doc.reference_number)}
          statusLabel={
            STATUS_KEYS[displayStatus]
              ? tCommon(`status.${STATUS_KEYS[displayStatus]}`)
              : String(displayStatus).replace("_", " ")
          }
          statusVariant={STATUS_VARIANT[displayStatus] ?? "secondary"}
          externalRef={typeof doc.external_ref === "string" ? doc.external_ref : null}
          externalSource={typeof doc.external_source === "string" ? doc.external_source : null}
        />
      }
      description={mode === "edit" ? t("drawer.editingHint") : (doc.party_name ?? undefined)}
      primaryAction={
        canEditStatus && mode === "edit" ? (
          <>
            <FormShortcuts
              enabled={!busy}
              actions={{
                save: () => void save(),
                saveAndNew: freshFormHref ? () => void save("new") : undefined,
                saveAndClose: () => void save("close"),
                postAndNew: canSaveAndPost
                  ? () => void save(freshFormHref ? "postNew" : "post")
                  : undefined,
                post: canSaveAndPost ? () => void save("post") : undefined,
              }}
            />
            <Button
              size="sm"
              variant={canSaveAndPost ? "outline" : "default"}
              className="h-8 px-2.5 text-xs"
              disabled={busy}
              title={tEntry("buttons.saveHint")}
              onClick={() => void save()}
            >
              {busy
                ? tCommon("actions.saving")
                : canSaveAndPost
                  ? tEntry("buttons.saveDraft")
                  : tCommon("actions.save")}
            </Button>
            {freshFormHref ? (
              <Button
                size="sm"
                variant="outline"
                className="h-8 px-2.5 text-xs"
                disabled={busy}
                title={tEntry("buttons.saveAndNewHint")}
                onClick={() => void save("new")}
              >
                {tEntry("buttons.saveAndNew")}
              </Button>
            ) : null}
            {canSaveAndPost ? (
              <Button
                size="sm"
                className="h-8 px-2.5 text-xs"
                disabled={busy}
                title={
                  freshFormHref ? tEntry("buttons.postAndNewHint") : tEntry("buttons.postHint")
                }
                onClick={() => void save(freshFormHref ? "postNew" : "post")}
              >
                {freshFormHref ? tEntry("buttons.postAndNew") : tEntry("buttons.post")}
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2.5 text-xs"
              disabled={busy}
              onClick={cancelWithConfirm}
            >
              {tCommon("actions.cancel")}
            </Button>
          </>
        ) : nextStepAction || (canEditStatus && editActionVisible) ? (
          <>
            {nextStepAction ? renderFormAction(nextStepAction, "header") : null}
            {canEditStatus && editActionVisible ? (
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-2.5 text-xs"
                disabled={busy}
                onClick={() => setMode("edit")}
              >
                {tCommon("actions.edit")}
              </Button>
            ) : null}
          </>
        ) : null
      }
      actionsMenuHeader={
        showFormPicker ? (
          <div className="mb-1.5 space-y-1.5 border-b border-slate-100 px-1 pb-2 dark:border-slate-800">
            <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
              {t("drawer.formLabel")}
            </span>
            <Select
              value={currentLayoutId ?? ""}
              onChange={(e) => router.push(hrefForDocument(String(doc.id), e.target.value))}
              aria-label={t("drawer.formLabel")}
              triggerClassName="!h-8 !min-h-0 !px-2 !py-0 !text-xs"
            >
              {availableLayouts!.map((availableLayout) => (
                <option key={availableLayout.id} value={availableLayout.id}>
                  {displayFormName(
                    availableLayout.name,
                    availableLayout.isDefault,
                    tCommon("labels.defaultForm"),
                  )}
                </option>
              ))}
            </Select>
            <Button
              variant="ghost"
              size="sm"
              className="!h-8 w-full !justify-start !px-2 !text-xs"
              onClick={() => setPreferredForm(currentLayoutId ?? null)}
              disabled={!currentLayoutId}
            >
              {t("drawer.formSetPreferred")}
            </Button>
          </div>
        ) : null
      }
      actions={
        // Editing keeps lifecycle actions out of reach until the record
        // saves; the only menu entry is the form-designer shortcut. Without
        // it there is no menu at all — the shell hides the button instead
        // of expanding an empty popover.
        mode === "edit" ? (
          actionLayout.find((action) => action.key === "customize")?.visible ? (
            renderFormAction("customize")
          ) : null
        ) : (
          <>
            {actionLayout
              .filter(
                (action) =>
                  action.visible && action.key !== "edit" && action.key !== nextStepAction,
              )
              .map((action) => (
                <Fragment key={action.key}>{renderFormAction(action.key)}</Fragment>
              ))}
            {(doc.kind === "customer_invoice" || doc.kind === "customer_credit") && canCreate ? (
              <SendButton recordType={String(doc.kind)} recordId={String(doc.id)} />
            ) : null}
            {doc.kind === "customer_invoice" && returnAuthorizationHref ? (
              <Button variant="outline" asChild>
                <Link href={returnAuthorizationHref}>{tReturns("actions.new")}</Link>
              </Button>
            ) : null}
            {settlementHref &&
            isPosted &&
            (doc.kind === "customer_invoice" || doc.kind === "vendor_bill") ? (
              <Button variant="outline" asChild>
                <Link href={settlementHref}>
                  {doc.kind === "customer_invoice"
                    ? t("actions.receivePayment")
                    : t("actions.payBill")}
                </Link>
              </Button>
            ) : null}
            {doc.kind === "cash_sale" && isPosted && refundHref && canCreate ? (
              <Button variant="outline" asChild>
                <Link href={refundHref}>{t("tenders.refundAction")}</Link>
              </Button>
            ) : null}
            {/* Till drop beside the settled cash: deep-link the Tenders tab
                where the deposit form (or the permission it needs) lives. */}
            {doc.kind === "cash_sale" && isPosted ? (
              canDeposit ? (
                <Button variant="outline" asChild>
                  <Link href={`${basePath}?doc=${String(doc.id)}&transactionTab=tenders`}>
                    {t("tenders.depositAction")}
                  </Link>
                </Button>
              ) : (
                <Button variant="outline" disabled title={t("tenders.depositRequiresPermission")}>
                  {t("tenders.depositAction")}
                </Button>
              )
            ) : null}
            {doc.kind === "vendor_bill" && isPosted && creditHref && canCreate ? (
              <Button variant="outline" asChild>
                <Link href={creditHref}>{t("actions.newCredit")}</Link>
              </Button>
            ) : null}
            {isPosted && doc.posting_effect_status === "terminal_failed" && canPost ? (
              <Button variant="outline" disabled={busy} onClick={retryPostingEffects}>
                {tPostingEffects("retry")}
              </Button>
            ) : null}
            {/* canPost is the approve grant for every drawer-registry kind
                (the permission catalog derives approve from the post grant),
                so this is approve-level authority, never just edit. */}
            {lifecycleAction("returnToDraft") ? (
              <Button variant="outline" disabled={busy} onClick={returnToDraft}>
                {tCommon("actions.returnToDraft")}
              </Button>
            ) : null}
          </>
        )
      }
      footer={
        <div className="flex w-full items-center gap-3">
          <span
            className={
              "text-xs " +
              (saveState === "error" || saveState === "unavailable"
                ? "text-red-600 dark:text-red-400"
                : "text-slate-500 dark:text-slate-400")
            }
          >
            {mode === "edit"
              ? saveState === "saving"
                ? tCommon("actions.saving")
                : saveState === "error"
                  ? t("drawer.saveState.error")
                  : saveState === "unavailable"
                    ? t("drawer.saveState.unavailable")
                    : dirty || saveState === "dirty"
                      ? t("drawer.saveState.dirty")
                      : null
              : null}
          </span>
          <span className="flex-1" />
          {/* A control total checks lines keyed from someone else's document:
              vendor bills and credits carry the vendor's printed total. */}
          {editable && config.partyRole === "vendor" && !isTransfer ? (
            <label
              className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400"
              title={tEntry("controlTotal.help")}
            >
              {tEntry("controlTotal.label")}
              <input
                inputMode="decimal"
                value={controlTotal}
                onChange={(event) => setControlTotal(event.target.value)}
                placeholder="—"
                aria-invalid={controlMismatch || undefined}
                className={
                  "h-7 w-28 rounded-md border bg-white px-2 text-right text-sm tabular-nums outline-none focus:ring-2 dark:bg-slate-900 " +
                  (controlMismatch
                    ? "border-red-400 text-red-700 focus:ring-red-500/30 dark:text-red-300"
                    : controlTotal && controlDifference !== null
                      ? "border-emerald-400 focus:ring-emerald-500/30"
                      : "border-slate-300 focus:ring-teal-500/25 dark:border-slate-700")
                }
              />
              {controlMismatch && controlDifference !== null ? (
                <span className="font-medium text-red-600 dark:text-red-400">
                  {tEntry("controlTotal.off", {
                    difference: money(controlDifference, { currency }),
                  })}
                </span>
              ) : null}
            </label>
          ) : null}
          <span className="text-sm text-slate-600 tabular-nums dark:text-slate-300">
            {editable && nativeGoods && !calculatedTotals ? (
              tCommon("nativeGoodsTax.previewUnavailable")
            ) : (
              <>
                {t("drawer.subtotalAmount", {
                  amount: money(effectiveTotals.subtotal, { currency }),
                })}
                {config.hasTax ? (
                  <>
                    {" "}
                    ·{" "}
                    {t("drawer.taxTotalAmount", {
                      amount: money(effectiveTotals.taxTotal, { currency }),
                    })}
                  </>
                ) : null}
                {" · "}
                <strong className="text-slate-900 dark:text-slate-100">
                  {t("drawer.totalAmount", {
                    amount: money(effectiveTotals.total, { currency }),
                  })}
                </strong>
                {isPosted && config.showsBalance ? (
                  <>
                    {" · "}
                    <strong className="text-slate-900 dark:text-slate-100">
                      {t("drawer.balanceDueAmount", {
                        amount: money(doc.balance_due, { currency: doc.currency }),
                      })}
                    </strong>
                  </>
                ) : null}
              </>
            )}
          </span>
        </div>
      }
    >
      {children}
    </TransactionDrawer>
  );
}
