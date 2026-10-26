import Link from "next/link";
import { toast } from "sonner";
import { ActionAlert } from "@braedonsaunders/appkit-errors/react";
import { PeriodClosedRefusal } from "@/components/period-closed-refusal";
import { Button, FieldLabel, Input, SearchSelect, Select } from "@openbooks/ui";
import { PromotionApplyControl } from "./promotion-apply";
import { LineGrid } from "./line-grid";
import { DistributionDialog } from "./allocations/DistributionDialog";
import { CustomFieldInputs } from "./custom-field-inputs";
import { HeaderFields } from "./transaction-form/header-fields";
import { BillMatchDialog } from "./bill-match-dialog";
import { ApprovalHistory } from "./approval-history";
import { DocumentFxRateField } from "./document-drawer-fx-rate";
import { lineText, type LineRow } from "./document-drawer-types";
import { emptyLine } from "./document-drawer-lines";
import type { DocumentDrawerHeaderScope } from "./document-drawer-header";
import { DateField } from "./date-field";
import { currencyMinorUnits } from "../lib/iso-currencies";
import { CONTROL_ACCOUNT_DETAIL, entryHeaderLayout } from "./document-drawer-entry";
import { RecallShortcut } from "./document-drawer-recall-shortcut";
import { STATUS_KEYS } from "./document-drawer-title";

/** The record body: refusals, banners, header fields, and the line grid. */
export function renderDocumentDrawerBody(scope: DocumentDrawerHeaderScope) {
  const {
    config,
    t,
    tCommon,
    tAlloc,
    tWithholdingLine,
    money,
    router,
    doc,
    payload,
    mode,
    editable,
    isCreate,
    createMode,
    isPosted,
    isTransfer,
    busy,
    refusal,
    postWarnings,
    canMatchBill,
    matchHint,
    matchRefused,
    setMatchRefused,
    matchOpen,
    setMatchOpen,
    nativeGoods,
    calculatedTotals,
    customValues,
    setCustomValues,
    transfer,
    setTransfer,
    accounts,
    bankAccounts,
    accountName,
    useLayout,
    layout,
    layoutShowsSubsidiary,
    renderHeaderField,
    multiSub,
    pickerPartyRole,
    partyLabel,
    partyPlaceholder,
    parties,
    partyId,
    changeParty,
    cards,
    paymentCardId,
    setPaymentCardId,
    cardAccountFallback,
    documentDate,
    setDocumentDate,
    dueDate,
    editDueDate,
    noTermsHint,
    referenceNumber,
    setReferenceNumber,
    memo,
    setMemo,
    headerDefs,
    controlSide,
    controlChoices,
    controlChoice,
    controlLabel,
    controlDefault,
    segments,
    extraDims,
    setExtraDims,
    promotionsEnabled,
    recordType,
    distOn,
    distEditable,
    distAuto,
    distApplying,
    applyDistAutomatic,
    showWithholdingLines,
    columns,
    columnsFromLayout,
    rows,
    handleGridRowsChange,
    distribution,
    dist,
    distCoordKey,
    distCodings,
    splitTarget,
    setSplitTarget,
    applyDialogRule,
    applyDialogChildren,
    afterContent,
    explicitFx,
    setExplicitFx,
    subsidiaryId,
    postingDate,
    tEntry,
    localDate,
    recallAvailable,
    recentDocument,
    recall,
    applyRecall,
    undoRecall,
    duplicates,
    partyDefaultHint,
    partyTaxHint,
    hrefForDocument,
    nativeGoodsTaxAvailable,
  } = scope;

  const field = "space-y-1.5";
  // While editing, the receivable/payable account sits under "More details"
  // with the other rarely-changed header fields.
  const headerLayout =
    layout && editable
      ? entryHeaderLayout(
          layout,
          tEntry("moreDetails"),
          controlSide && controlChoices ? [CONTROL_ACCOUNT_DETAIL] : [],
        )
      : layout;
  const controlInDetails = Boolean(
    headerLayout &&
    headerLayout !== layout &&
    headerLayout.header.groups.some((group) =>
      group.fields.some((placement) => placement.key === CONTROL_ACCOUNT_DETAIL.key),
    ),
  );
  return (
    <div className="space-y-6 p-1">
      <ActionAlert error={refusal} fallbackMessage={t("toasts.actionFailed")} />
      <PeriodClosedRefusal error={refusal} />
      {postWarnings.map((warning, index) => (
        <p
          key={index}
          role="alert"
          className="rounded-md border border-amber-200 bg-amber-50 p-2.5 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
        >
          {warning}
        </p>
      ))}
      {editable && duplicates.length > 0 ? (
        <div
          role="alert"
          className="rounded-md border border-amber-300 bg-amber-50 p-2.5 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <p className="font-medium">{tEntry("duplicate.title")}</p>
          <ul className="mt-1 space-y-0.5">
            {duplicates.slice(0, 3).map((match) => (
              <li key={match.id}>
                <Link
                  className="underline decoration-dotted hover:text-amber-700"
                  href={hrefForDocument(match.id)}
                >
                  {tEntry("duplicate.match", {
                    number: match.documentNumber,
                    date: localDate(match.documentDate),
                    total: match.total ? money(match.total, { currency: doc.currency }) : "—",
                    status:
                      match.status && STATUS_KEYS[match.status]
                        ? tCommon(`status.${STATUS_KEYS[match.status]}`)
                        : (match.status ?? ""),
                  })}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {editable && (recallAvailable || recall) && recentDocument ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-200">
          {recall ? (
            <>
              <span className="min-w-48 flex-1">
                {tEntry("recall.applied", { number: recall.documentNumber ?? "" })}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={undoRecall}
              >
                {tEntry("recall.undo")}
              </Button>
            </>
          ) : (
            <>
              <RecallShortcut
                enabled={recallAvailable}
                onRecall={applyRecall}
                label={tEntry("recall.shortcut")}
              />
              <span className="min-w-48 flex-1">
                {tEntry("recall.offer", {
                  number: recentDocument.documentNumber ?? "",
                  date: localDate(recentDocument.documentDate),
                  total: money(recentDocument.total, {
                    currency: recentDocument.currency ?? doc.currency,
                  }),
                  lines: recentDocument.lines.length,
                })}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                title={tEntry("recall.shortcutHint")}
                onClick={applyRecall}
              >
                {tEntry("recall.use")}
              </Button>
            </>
          )}
        </div>
      ) : null}
      {canMatchBill && (matchHint || matchRefused) ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-amber-200 bg-amber-50 p-2.5 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
        >
          <p className="min-w-48 flex-1">{t("drawer.matchBanner")}</p>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setMatchOpen(true)}>
            {t("match.title")}
          </Button>
        </div>
      ) : null}
      {matchOpen && canMatchBill ? (
        <BillMatchDialog
          billId={String(doc.id)}
          onClose={() => setMatchOpen(false)}
          onMatched={() => {
            setMatchOpen(false);
            setMatchRefused(false);
            toast.success(t("match.matched"));
            router.refresh();
          }}
        />
      ) : null}
      {config.kind === "customer_invoice" &&
      ((editable && nativeGoodsTaxAvailable === true) || nativeGoods) ? (
        <div className="space-y-3 border-b p-4">
          <div className="space-y-1">
            <FieldLabel fieldName={tCommon("nativeGoodsTax.title")}>
              {tCommon("nativeGoodsTax.title")}
            </FieldLabel>
            {editable ? (
              <Select
                value={nativeGoods ? "native" : "manual"}
                onChange={(event) =>
                  setCustomValues((values) => ({
                    ...values,
                    canadianGoodsTax:
                      event.target.value === "native"
                        ? {
                            basis: "ordinary_taxable_goods_sale",
                            country: "CA",
                            deliveryProvince: "",
                            deliveryMethod: "delivered_or_made_available",
                            agreementEvidence: "",
                          }
                        : null,
                  }))
                }
              >
                <option value="manual">{tCommon("nativeGoodsTax.manual")}</option>
                <option value="native">{tCommon("nativeGoodsTax.automatic")}</option>
              </Select>
            ) : (
              <p>{tCommon("nativeGoodsTax.automatic")}</p>
            )}
          </div>
          {nativeGoods ? (
            <>
              <p className="text-xs text-slate-500">{tCommon("nativeGoodsTax.help")}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <FieldLabel fieldName={tCommon("nativeGoodsTax.province")}>
                    {tCommon("nativeGoodsTax.province")}
                  </FieldLabel>
                  {editable ? (
                    <Select
                      value={nativeGoods.deliveryProvince}
                      onChange={(event) =>
                        setCustomValues((values) => ({
                          ...values,
                          canadianGoodsTax: {
                            ...nativeGoods,
                            deliveryProvince: event.target.value,
                          },
                        }))
                      }
                    >
                      <option value="">—</option>
                      {[
                        "AB",
                        "BC",
                        "MB",
                        "NB",
                        "NL",
                        "NS",
                        "NT",
                        "NU",
                        "ON",
                        "PE",
                        "QC",
                        "SK",
                        "YT",
                      ].map((province) => (
                        <option key={province} value={province}>
                          {province}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <p>{nativeGoods.deliveryProvince}</p>
                  )}
                </div>
                <div>
                  <FieldLabel fieldName={tCommon("nativeGoodsTax.delivery")}>
                    {tCommon("nativeGoodsTax.delivery")}
                  </FieldLabel>
                  {editable ? (
                    <Select
                      value={nativeGoods.deliveryMethod}
                      onChange={(event) =>
                        setCustomValues((values) => ({
                          ...values,
                          canadianGoodsTax: { ...nativeGoods, deliveryMethod: event.target.value },
                        }))
                      }
                    >
                      {[
                        "delivered_or_made_available",
                        "supplier_arranged_shipping",
                        "recipient_collection",
                      ].map((method) => (
                        <option key={method} value={method}>
                          {tCommon(`nativeGoodsTax.${method}`)}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <p>{tCommon(`nativeGoodsTax.${nativeGoods.deliveryMethod}`)}</p>
                  )}
                </div>
              </div>
              <div>
                <FieldLabel fieldName={tCommon("nativeGoodsTax.evidence")}>
                  {tCommon("nativeGoodsTax.evidence")}
                </FieldLabel>
                {editable ? (
                  <Input
                    value={nativeGoods.agreementEvidence}
                    maxLength={4000}
                    onChange={(event) =>
                      setCustomValues((values) => ({
                        ...values,
                        canadianGoodsTax: { ...nativeGoods, agreementEvidence: event.target.value },
                      }))
                    }
                  />
                ) : (
                  <p>{nativeGoods.agreementEvidence}</p>
                )}
              </div>
              {editable &&
              (!nativeGoods.deliveryProvince ||
                nativeGoods.agreementEvidence.trim().length < 20 ||
                !calculatedTotals) ? (
                <p role="alert" className="text-sm text-amber-700">
                  {tCommon("nativeGoodsTax.incomplete")}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      {isTransfer ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className={field}>
            <FieldLabel fieldName={t("drawer.transferAmount")}>
              {t("drawer.transferAmount")}
              {editable ? <span className="text-red-500"> *</span> : null}
            </FieldLabel>
            {editable ? (
              <Input
                type="number"
                step="0.01"
                value={transfer?.amount ?? ""}
                onChange={(e) => setTransfer((p) => ({ ...p!, amount: e.target.value }))}
              />
            ) : (
              <p className="text-sm tabular-nums">
                {money(lineText(payload.lines[0]?.amount), { currency: doc.currency })}
              </p>
            )}
          </div>
          <div className={field}>
            <FieldLabel fieldName={t("drawer.toAccount")}>
              {t("drawer.toAccount")}
              {editable ? <span className="text-red-500"> *</span> : null}
            </FieldLabel>
            {editable ? (
              <SearchSelect
                options={(bankAccounts ?? accounts).map((a) => ({
                  value: a.id,
                  label: `${a.number ?? ""} ${a.name ?? ""}`.trim(),
                }))}
                value={transfer?.toAccount ?? ""}
                onChange={(v) => setTransfer((p) => ({ ...p!, toAccount: v ?? "" }))}
                placeholder={t("drawer.accountPlaceholder")}
              />
            ) : (
              <p className="text-sm">{accountName(payload.lines[0]?.account_id)}</p>
            )}
          </div>
          <div className={field}>
            <FieldLabel fieldName={t("drawer.fromAccount")}>
              {t("drawer.fromAccount")}
              {editable ? <span className="text-red-500"> *</span> : null}
            </FieldLabel>
            {editable ? (
              <SearchSelect
                options={(bankAccounts ?? accounts).map((a) => ({
                  value: a.id,
                  label: `${a.number ?? ""} ${a.name ?? ""}`.trim(),
                }))}
                value={transfer?.fromAccount ?? ""}
                onChange={(v) => setTransfer((p) => ({ ...p!, fromAccount: v ?? "" }))}
                placeholder={t("drawer.accountPlaceholder")}
              />
            ) : (
              <p className="text-sm">{accountName(payload.lines[1]?.account_id)}</p>
            )}
          </div>
        </div>
      ) : null}

      {config.fundingSource === "bank" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className={field}>
            <FieldLabel
              fieldName={
                config.kind === "deposit" ? t("drawer.depositTo") : t("drawer.fromAccount")
              }
            >
              {config.kind === "deposit" ? t("drawer.depositTo") : t("drawer.fromAccount")}
              {editable ? <span className="text-red-500"> *</span> : null}
            </FieldLabel>
            {editable ? (
              // Zero bank accounts is valid data (a fresh org), not a broken
              // source: name it with a way forward instead of a dead
              // 'No matches' picker with no search.
              (bankAccounts ?? accounts).length > 0 ? (
                <SearchSelect
                  options={(bankAccounts ?? accounts).map((a) => ({
                    value: a.id,
                    label: `${a.number ?? ""} ${a.name ?? ""}`.trim(),
                  }))}
                  value={(customValues.controlAccountId as string) ?? ""}
                  onChange={(v) => setCustomValues((c) => ({ ...c, controlAccountId: v ?? "" }))}
                  placeholder={t("drawer.accountPlaceholder")}
                />
              ) : (
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  {t("drawer.noBankAccounts")}{" "}
                  <Link
                    href="/banking"
                    className="font-medium text-teal-700 hover:underline dark:text-teal-300"
                  >
                    {t("drawer.noBankAccountsCta")}
                  </Link>
                </p>
              )
            ) : (
              <p className="text-sm">{accountName(customValues.controlAccountId as string)}</p>
            )}
          </div>
        </div>
      ) : null}

      {useLayout ? (
        <>
          <HeaderFields
            layout={headerLayout!}
            editable={editable}
            renderField={renderHeaderField}
            expandDetails={!createMode}
          />
          {multiSub && !layoutShowsSubsidiary ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className={field}>
                {renderHeaderField({ key: "subsidiary_id", visible: true }, editable)}
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {pickerPartyRole ? (
              <div className={`${field} lg:col-span-2`}>
                <FieldLabel fieldName={partyLabel}>
                  {partyLabel}
                  {editable && config.partyRole ? <span className="text-red-500"> *</span> : null}
                </FieldLabel>
                {editable ? (
                  <SearchSelect
                    options={(parties ?? []).map((p) => ({
                      value: p.id,
                      label: p.display_name ?? "",
                    }))}
                    value={partyId}
                    onChange={changeParty}
                    placeholder={partyPlaceholder}
                  />
                ) : (
                  <p className="text-sm">{doc.party_name}</p>
                )}
              </div>
            ) : null}

            {config.fundingSource === "card" ? (
              <div className={`${field} lg:col-span-2`}>
                <FieldLabel fieldName={t("drawer.card")}>
                  {t("drawer.card")}
                  {editable ? <span className="text-red-500"> *</span> : null}
                </FieldLabel>
                {(() => {
                  const savedCardName =
                    (cards ?? []).find((c) => c.id === doc.payment_card_id)?.display_name ??
                    doc.payment_card_id;
                  if (editable) {
                    return (cards ?? []).length > 0 ? (
                      <SearchSelect
                        options={(cards ?? []).map((c) => ({
                          value: c.id,
                          label: c.display_name ?? c.label ?? "",
                        }))}
                        value={paymentCardId}
                        onChange={(v) => setPaymentCardId(v ?? "")}
                        placeholder={t("drawer.selectCardPlaceholder")}
                      />
                    ) : (
                      cardAccountFallback(true)
                    );
                  }
                  return savedCardName ? (
                    <p className="text-sm">{savedCardName}</p>
                  ) : (
                    cardAccountFallback(false)
                  );
                })()}
              </div>
            ) : null}

            {multiSub ? (
              <div className={field}>
                {renderHeaderField({ key: "subsidiary_id", visible: true }, editable)}
              </div>
            ) : null}

            <div className={field}>
              <FieldLabel fieldName={t("drawer.dateLabel")}>{t("drawer.dateLabel")}</FieldLabel>
              {editable ? (
                <DateField value={documentDate} onChange={(value) => setDocumentDate(value)} />
              ) : (
                <p className="text-sm">{doc.document_date}</p>
              )}
            </div>
            {config.hasDueDate ? (
              <div className={field}>
                <FieldLabel fieldName={t("drawer.dueDate")}>{t("drawer.dueDate")}</FieldLabel>
                {editable ? (
                  <>
                    <DateField value={dueDate} onChange={(value) => editDueDate(value)} />
                    {noTermsHint ? (
                      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                        {tCommon("documentDefaults.noPaymentTerms", { name: noTermsHint })}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="text-sm">{doc.due_date ?? "—"}</p>
                )}
              </div>
            ) : null}
            {config.hasReference ? (
              <div className={field}>
                <FieldLabel fieldName={t("drawer.reference")}>{t("drawer.reference")}</FieldLabel>
                {editable ? (
                  <Input
                    value={referenceNumber}
                    onChange={(e) => setReferenceNumber(e.target.value)}
                  />
                ) : (
                  <p className="text-sm">{doc.reference_number ?? "—"}</p>
                )}
              </div>
            ) : null}
            <div className={`${field} lg:col-span-3`}>
              <FieldLabel fieldName={tCommon("labels.memo")}>{tCommon("labels.memo")}</FieldLabel>
              {editable ? (
                <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
              ) : (
                <p className="text-sm">{doc.memo ?? "—"}</p>
              )}
            </div>
          </div>

          <CustomFieldInputs
            defs={headerDefs}
            values={customValues}
            onChange={setCustomValues}
            readOnly={!editable}
          />
        </>
      )}

      <DocumentFxRateField
        kind={config.kind}
        doc={doc}
        editable={editable}
        isCreate={isCreate}
        subsidiaryId={subsidiaryId}
        documentDate={documentDate}
        postingDate={postingDate}
        pending={explicitFx}
        onChange={setExplicitFx}
      />

      {controlSide && controlChoices && !controlInDetails ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className={field}>
            <FieldLabel fieldName={t("drawer.controlAccount")}>
              {t("drawer.controlAccount")}
            </FieldLabel>
            {editable ? (
              <>
                <SearchSelect
                  options={controlChoices.accounts.map((option) => ({
                    value: option.id,
                    label: controlLabel(option),
                  }))}
                  value={controlChoice}
                  onChange={(value) =>
                    setCustomValues((current) => ({ ...current, controlAccountId: value ?? "" }))
                  }
                  placeholder={controlDefault}
                  clearable
                  emptyLabel={controlDefault}
                  ariaLabel={t("drawer.controlAccount")}
                />
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {t("drawer.controlAccountHelp")}
                </p>
              </>
            ) : (
              <p className="text-sm">
                {isPosted && controlChoices.posted
                  ? controlLabel(controlChoices.posted)
                  : controlChoice
                    ? controlLabel(controlChoices.selected) || controlChoice
                    : controlDefault}
              </p>
            )}
          </div>
        </div>
      ) : null}

      {segments.some((segment) => segment.showOnHeader) ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {segments
            .filter((segment) => segment.showOnHeader)
            .map((segment) => {
              const selected = extraDims[segment.key] ?? "";
              const selectedLabel = segment.values.find((value) => value.id === selected);
              return (
                <div className={field} key={segment.key}>
                  <FieldLabel fieldName={segment.name}>{segment.name}</FieldLabel>
                  {editable ? (
                    <SearchSelect
                      options={segment.values.map((value) => ({
                        value: value.id,
                        label: `${value.code ? `${value.code} · ` : ""}${value.name}`,
                      }))}
                      value={selected}
                      onChange={(value) =>
                        setExtraDims((current) => ({ ...current, [segment.key]: value || null }))
                      }
                      placeholder="—"
                    />
                  ) : (
                    <p className="text-sm">{selectedLabel?.name ?? "—"}</p>
                  )}
                </div>
              );
            })}
        </div>
      ) : null}

      {!isTransfer ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <FieldLabel fieldName={tCommon("labels.lines")}>{tCommon("labels.lines")}</FieldLabel>
            {promotionsEnabled === true &&
            recordType === "customer_invoice" &&
            editable &&
            !createMode &&
            doc.id !== "" &&
            doc.status === "draft" ? (
              <PromotionApplyControl
                documentId={doc.id}
                currency={doc.currency}
                onApplied={() => router.refresh()}
              />
            ) : null}
            {distOn && distEditable && distAuto.length > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={distApplying}
                onClick={() => void applyDistAutomatic()}
              >
                {tAlloc("entry.applyAutomatic")}
              </Button>
            ) : null}
          </div>
          {config.kind === "vendor_bill" && showWithholdingLines ? (
            <p className="text-xs text-muted-foreground">{tWithholdingLine("directCostHelp")}</p>
          ) : null}
          <LineGrid<LineRow>
            columns={useLayout ? columnsFromLayout : columns}
            rows={rows}
            onRowsChange={handleGridRowsChange}
            emptyRow={emptyLine}
            getRowKey={(row, i) => (row.clientKey !== "" ? row.clientKey : `row-${i}`)}
            cloneRow={(row) => ({ ...row, clientKey: crypto.randomUUID() })}
            readOnly={!editable || config.kind === "project_charge"}
            formatAmount={(value) => money(value, { currency: doc.currency })}
            distribution={distribution}
            minorUnits={currencyMinorUnits(String(doc.currency ?? ""))}
          />
          {editable && partyDefaultHint ? (
            <p className="text-[11px] text-slate-500 dark:text-slate-400">{partyDefaultHint}</p>
          ) : null}
          {editable && partyTaxHint ? (
            <p className="text-[11px] text-slate-500 dark:text-slate-400">{partyTaxHint}</p>
          ) : null}
        </div>
      ) : null}
      {splitTarget !== null && rows[splitTarget] ? (
        <DistributionDialog
          key={`${splitTarget}:${rows[splitTarget]!.amount}:${rows[splitTarget]!.distributionKey}`}
          open
          lineAmount={rows[splitTarget]!.amount || "0"}
          candidates={dist.cache.get(distCoordKey(rows[splitTarget]!)) ?? []}
          candidatesFailed={dist.failed.has(distCoordKey(rows[splitTarget]!))}
          accountOptions={accounts.map((a) => ({
            value: a.id,
            label: `${a.number ?? ""} ${a.name ?? ""}`.trim(),
          }))}
          codings={distCodings}
          initialRuleKey={rows[splitTarget]!.distributionKey || null}
          onClose={() => setSplitTarget(null)}
          onApplyRule={applyDialogRule}
          onApplyChildren={applyDialogChildren}
        />
      ) : null}

      {mode === "view" && !isCreate ? (
        // The record's tenant-authored Flow approval timeline. Renders
        // nothing when no approval flow applies. Never in create mode:
        // no persisted record exists to carry a timeline yet.
        <ApprovalHistory subjectKind={String(doc.kind)} subjectId={String(doc.id)} />
      ) : null}

      {mode === "view" ? afterContent : null}
    </div>
  );
}
