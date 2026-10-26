import { useCallback, useId, useMemo, useState } from "react";
import Link from "next/link";
import { FieldLabel, Input, SearchSelect, Select } from "@openbooks/ui";
import { readApiErrorMessage } from "../lib/api-error";
import { CustomFieldInput } from "./custom-field-input";
import { postedCorrectionFieldClass } from "@openbooks/engine/ledger/posted-correction-fields";
import {
  type HeaderFieldPlacement,
  customFieldDefKey,
  isCustomFieldKey,
} from "@openbooks/customization";
import type { Opt } from "./document-drawer-types";
import type { DocumentDrawerColumnsScope } from "./document-drawer-columns";
import { DateField } from "./date-field";

/** Header field rendering shared by the form-layout and fallback headers. */
export function useDocumentDrawerHeader(scope: DocumentDrawerColumnsScope) {
  const {
    config,
    t,
    tCommon,
    doc,
    isPosted,
    accountName,
    headerDefs,
    builtinSegments,
    cards,
    cardAccounts,
    parties,
    partyId,
    changeParty,
    customValues,
    setCustomValues,
    paymentCardId,
    setPaymentCardId,
    documentDate,
    setDocumentDate,
    dueDate,
    editDueDate,
    noTermsHint,
    referenceNumber,
    setReferenceNumber,
    memo,
    setMemo,
    postingDate,
    setPostingDate,
    expectedPayDate,
    setExpectedPayDate,
    carriesWorkDates,
    workCompletedOn,
    setWorkCompletedOn,
    departments,
    departmentId,
    setDepartmentId,
    projects,
    projectIdHeader,
    setProjectIdHeader,
    locations,
    locationId,
    setLocationId,
    classes,
    classId,
    setClassId,
    multiSub,
    subsidiaryOpts,
    subsidiaryId,
    setSubsidiaryId,
    subsidiaryName,
    offersCurrency,
    currencyOptions,
    currency,
    setCurrency,
    setCurrencyChosen,
    paymentHoldReason,
    setPaymentHoldReason,
    internalNotes,
    setInternalNotes,
    billingMethod,
    setBillingMethod,
    isFinalInvoice,
    setIsFinalInvoice,
    isCreate,
    tEntry,
    controlSide,
    controlChoices,
    controlChoice,
    controlLabel,
    controlDefault,
  } = scope;

  // Labels name their controls (click-to-focus, screen readers, and F1
  // help all resolve a field through this association).
  const idPrefix = useId();
  const fieldId = (key: string) => `${idPrefix}-${key}`;

  // Card-instrument fallback: no UI creates payment_cards rows,
  // so with zero instruments the instrument picker is unfillable. Offer the
  // reconcilable card-liability accounts as the controlAccountId override
  // the engine cardRule reads first; name what qualifies when those are
  // absent too. Unused while instruments exist.
  const cardAccountFallback = (editable: boolean) => {
    if (editable) {
      return (cardAccounts ?? []).length > 0 ? (
        <>
          <SearchSelect
            options={(cardAccounts ?? []).map((a) => ({
              value: a.id,
              label: `${a.number ?? ""} ${a.name ?? ""}`.trim(),
            }))}
            value={(customValues.controlAccountId as string) ?? ""}
            onChange={(v) => setCustomValues((c) => ({ ...c, controlAccountId: v ?? "" }))}
            placeholder={t("drawer.accountPlaceholder")}
          />
          {customValues.controlAccountId ? null : (
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {t("drawer.cardAccountHelp")}
            </p>
          )}
        </>
      ) : (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {t("drawer.noCardAccounts")}{" "}
          <Link
            href="/accounts"
            className="font-medium text-teal-700 hover:underline dark:text-teal-300"
          >
            {t("drawer.noCardAccountsCta")}
          </Link>
        </p>
      );
    }
    return <p className="text-sm">{accountName(customValues.controlAccountId)}</p>;
  };
  // Header party picker role: a mandatory partyRole, else an opt-in payee
  // (optionalPartyRole) that never blocks save/submit/post or the server edit
  // guard — both key off config.partyRole alone.
  const pickerPartyRole = config.partyRole ?? config.optionalPartyRole ?? null;
  const partyLabel =
    pickerPartyRole === "customer" ? tCommon("labels.customer") : tCommon("labels.vendor");
  const partyPlaceholder =
    pickerPartyRole === "customer"
      ? t("drawer.selectCustomerPlaceholder")
      : t("drawer.selectVendorPlaceholder");

  // Parties created inline from the picker join its options at once; the
  // page's own list catches up on the next load.
  const [createdParties, setCreatedParties] = useState<{ id: string; display_name: string }[]>([]);
  const partyOptions = useMemo(() => {
    const known = new Set((parties ?? []).map((party) => party.id));
    return [
      ...(parties ?? []).map((party) => ({
        value: party.id,
        label: party.display_name ?? "",
        hint: party.short_code ?? undefined,
        keywords: party.short_code ? [party.short_code] : undefined,
      })),
      ...createdParties
        .filter((party) => !known.has(party.id))
        .map((party) => ({ value: party.id, label: party.display_name })),
    ];
  }, [parties, createdParties]);
  /**
   * Create a vendor or customer from the picker with just its name, through
   * the same party command as the directory (permissions, audit and
   * duplicate-code refusals included). Further details are added later on
   * the party record.
   */
  const createParty = useCallback(
    async (name: string) => {
      if (!pickerPartyRole) return null;
      const response = await fetch("/api/parties", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          kind: "company",
          displayName: name,
          roles: { [pickerPartyRole]: { enabled: true } },
        }),
      });
      if (!response.ok)
        throw new Error(await readApiErrorMessage(response, tEntry("createParty.failed")));
      const body = (await response.json().catch(() => null)) as {
        party?: { id?: unknown; display_name?: unknown };
      } | null;
      const id = typeof body?.party?.id === "string" ? body.party.id : null;
      if (!id) throw new Error(tEntry("createParty.failed"));
      const label = typeof body?.party?.display_name === "string" ? body.party.display_name : name;
      setCreatedParties((current) => [...current, { id, display_name: label }]);
      return { value: id, label };
    },
    [pickerPartyRole, tEntry],
  );

  const headerDefByDefKey = useMemo(() => new Map(headerDefs.map((d) => [d.key, d])), [headerDefs]);
  const defLabelForHeader = (key: string): string => {
    switch (key) {
      case "party_id":
        return partyLabel;
      case "payment_card_id":
        return t("drawer.card");
      case "document_date":
        return t("drawer.dateLabel");
      case "due_date":
        return t("drawer.dueDate");
      case "reference_number":
        return t("drawer.reference");
      case "memo":
        return tCommon("labels.memo");
      case "posting_date":
        return tCommon("labels.postingDate");
      case "department_id":
        return tCommon("labels.department");
      case "project_id":
        return tCommon("labels.project");
      case "location_id":
        return tCommon("labels.location");
      case "class_id":
        return tCommon("labels.class");
      case "subsidiary_id":
        return tCommon("labels.subsidiary");
      case "currency":
        return tCommon("labels.currency");
      case "expected_pay_date":
        return tCommon("labels.expectedPayDate");
      case "work_completed_on":
        return tCommon("labels.workCompletedOn");
      case "payment_hold_reason":
        return tCommon("labels.paymentHold");
      case "internal_notes":
        return tCommon("labels.internalNotes");
      case "billing_method":
        return tCommon("labels.billingMethod");
      case "is_final_invoice":
        return tCommon("labels.finalInvoice");
      default:
        if (isCustomFieldKey(key))
          return headerDefByDefKey.get(customFieldDefKey(key))?.label ?? key;
        return key;
    }
  };

  // Look up a dimension/entity display name for read-only header rendering.
  const optName = (opts: Opt[] | undefined, id: unknown): string =>
    (opts ?? []).find((o) => o.id === id)?.name ??
    (opts ?? []).find((o) => o.id === id)?.display_name ??
    "—";

  const renderHeaderField = (p: HeaderFieldPlacement, isEditable: boolean): React.ReactNode => {
    if (builtinSegments.find((segment) => segment.storageColumn === p.key)?.showOnHeader === false)
      return null;
    const label = p.labelOverride?.trim() ? p.labelOverride.trim() : defLabelForHeader(p.key);
    const required = p.required === true;
    switch (p.key) {
      case "party_id":
        return (
          <>
            <FieldLabel htmlFor={fieldId(p.key)} fieldName={label}>
              {label}
              {required && isEditable ? <span className="text-red-500"> *</span> : null}
            </FieldLabel>
            {isEditable ? (
              <SearchSelect
                id={fieldId(p.key)}
                options={partyOptions}
                value={partyId}
                onChange={changeParty}
                placeholder={partyPlaceholder}
                advanceOnSelect
                recentKey={pickerPartyRole ? `party:${pickerPartyRole}` : undefined}
                onCreate={pickerPartyRole ? createParty : undefined}
                createLabel={(query) =>
                  pickerPartyRole === "customer"
                    ? tEntry("createParty.customer", { name: query })
                    : tEntry("createParty.vendor", { name: query })
                }
                data-autofocus={isCreate && !partyId ? true : undefined}
              />
            ) : (
              <p className="text-sm">{doc.party_name}</p>
            )}
          </>
        );
      case "payment_card_id": {
        const savedCardName =
          (cards ?? []).find((c) => c.id === doc.payment_card_id)?.display_name ??
          doc.payment_card_id;
        return (
          <>
            <FieldLabel htmlFor={fieldId(p.key)} fieldName={label}>
              {label}
              {required && isEditable ? <span className="text-red-500"> *</span> : null}
            </FieldLabel>
            {isEditable ? (
              (cards ?? []).length > 0 ? (
                <SearchSelect
                  id={fieldId(p.key)}
                  options={(cards ?? []).map((c) => ({
                    value: c.id,
                    label: c.display_name ?? c.label ?? "",
                  }))}
                  value={paymentCardId}
                  onChange={(v) => setPaymentCardId(v ?? "")}
                  placeholder={t("drawer.selectCardPlaceholder")}
                  advanceOnSelect
                  data-autofocus={isCreate && !paymentCardId && !pickerPartyRole ? true : undefined}
                />
              ) : (
                cardAccountFallback(true)
              )
            ) : savedCardName ? (
              <p className="text-sm">{savedCardName}</p>
            ) : (
              cardAccountFallback(false)
            )}
          </>
        );
      }
      case "document_date":
        return (
          <>
            <FieldLabel htmlFor={fieldId(p.key)} fieldName={label}>
              {label}
            </FieldLabel>
            {isEditable ? (
              <DateField
                id={fieldId(p.key)}
                value={documentDate}
                onChange={(value) => setDocumentDate(value)}
              />
            ) : (
              <p className="text-sm">{doc.document_date}</p>
            )}
          </>
        );
      case "due_date":
        return (
          <>
            <FieldLabel htmlFor={fieldId(p.key)} fieldName={label}>
              {label}
            </FieldLabel>
            {isEditable ? (
              <>
                <DateField
                  id={fieldId(p.key)}
                  value={dueDate}
                  onChange={(value) => editDueDate(value)}
                />
                {noTermsHint ? (
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {pickerPartyRole === "vendor"
                      ? tEntry("noPaymentTermsVendor", { name: noTermsHint })
                      : tCommon("documentDefaults.noPaymentTerms", { name: noTermsHint })}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-sm">{doc.due_date ?? "—"}</p>
            )}
          </>
        );
      case "reference_number":
        return (
          <>
            <FieldLabel htmlFor={fieldId(p.key)} fieldName={label}>
              {label}
            </FieldLabel>
            {isEditable ? (
              <Input
                id={fieldId(p.key)}
                autoComplete="off"
                value={referenceNumber}
                onChange={(e) => setReferenceNumber(e.target.value)}
              />
            ) : (
              <p className="text-sm">{doc.reference_number ?? "—"}</p>
            )}
          </>
        );
      case "memo":
        return (
          <>
            <FieldLabel htmlFor={fieldId(p.key)} fieldName={label}>
              {label}
            </FieldLabel>
            {isEditable ? (
              <Input id={fieldId(p.key)} value={memo} onChange={(e) => setMemo(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.memo ?? "—"}</p>
            )}
          </>
        );
      case "posting_date": {
        // Posting dates place the document in its period: the posted
        // correction classification treats them as financial, so the
        // posted-document edit form shows the stored date without offering
        // it. A posted date changes only through void-and-reissue, and
        // offering the input here used to record no-change corrections.
        const canOfferPostingDate =
          isEditable && (!isPosted || postedCorrectionFieldClass("postingDate") !== "financial");
        return (
          <>
            <FieldLabel htmlFor={fieldId(p.key)} fieldName={label}>
              {label}
            </FieldLabel>
            {canOfferPostingDate ? (
              <>
                <DateField
                  id={fieldId(p.key)}
                  value={postingDate}
                  onChange={(value) => setPostingDate(value)}
                />
                {!postingDate && /^\d{4}-\d{2}-\d{2}$/.test(documentDate) && !isPosted ? (
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {tCommon("documentDefaults.postingDateFallback", { date: documentDate })}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-sm">{doc.posting_date ?? "—"}</p>
            )}
          </>
        );
      }
      case "expected_pay_date":
        return (
          <>
            <FieldLabel htmlFor={fieldId(p.key)} fieldName={label}>
              {label}
            </FieldLabel>
            {isEditable ? (
              <DateField
                id={fieldId(p.key)}
                value={expectedPayDate}
                onChange={(value) => setExpectedPayDate(value)}
              />
            ) : (
              <p className="text-sm">{doc.expected_pay_date ?? "—"}</p>
            )}
          </>
        );
      case "work_completed_on":
        if (!carriesWorkDates) return null;
        return (
          <>
            <FieldLabel htmlFor={fieldId(p.key)} fieldName={label}>
              {label}
            </FieldLabel>
            {isEditable ? (
              <DateField
                id={fieldId(p.key)}
                value={workCompletedOn}
                onChange={(value) => setWorkCompletedOn(value)}
              />
            ) : (
              <p className="text-sm">{doc.work_completed_on ?? "—"}</p>
            )}
          </>
        );
      case "department_id":
        return (
          <>
            <FieldLabel htmlFor={fieldId(p.key)} fieldName={label}>
              {label}
            </FieldLabel>
            {isEditable ? (
              <SearchSelect
                id={fieldId(p.key)}
                advanceOnSelect
                options={(departments ?? []).map((d) => ({ value: d.id, label: d.name ?? "" }))}
                value={departmentId}
                onChange={(v) => setDepartmentId(v ?? "")}
                placeholder="—"
              />
            ) : (
              <p className="text-sm">{optName(departments, doc.department_id)}</p>
            )}
          </>
        );
      case "project_id":
        return (
          <>
            <FieldLabel htmlFor={fieldId(p.key)} fieldName={label}>
              {label}
            </FieldLabel>
            {isEditable && config.kind !== "project_charge" ? (
              <SearchSelect
                id={fieldId(p.key)}
                advanceOnSelect
                options={(projects ?? []).map((pr) => ({ value: pr.id, label: pr.name ?? "" }))}
                value={projectIdHeader}
                onChange={(v) => setProjectIdHeader(v ?? "")}
                placeholder="—"
              />
            ) : (
              <p className="text-sm">{optName(projects, doc.project_id)}</p>
            )}
          </>
        );
      case "location_id":
        return (
          <>
            <FieldLabel htmlFor={fieldId(p.key)} fieldName={label}>
              {label}
            </FieldLabel>
            {isEditable ? (
              <SearchSelect
                id={fieldId(p.key)}
                advanceOnSelect
                options={(locations ?? []).map((l) => ({ value: l.id, label: l.name ?? "" }))}
                value={locationId}
                onChange={(v) => setLocationId(v ?? "")}
                placeholder="—"
              />
            ) : (
              <p className="text-sm">{optName(locations, doc.location_id)}</p>
            )}
          </>
        );
      case "class_id":
        return (
          <>
            <FieldLabel htmlFor={fieldId(p.key)} fieldName={label}>
              {label}
            </FieldLabel>
            {isEditable ? (
              <SearchSelect
                id={fieldId(p.key)}
                advanceOnSelect
                options={(classes ?? []).map((c) => ({ value: c.id, label: c.name ?? "" }))}
                value={classId}
                onChange={(v) => setClassId(v ?? "")}
                placeholder="—"
              />
            ) : (
              <p className="text-sm">{optName(classes, doc.class_id)}</p>
            )}
          </>
        );
      case "subsidiary_id": {
        // HARD RULE: no subsidiary UI in single-subsidiary orgs, even if a
        // form layout carries the field. Locked (read-only) once posted — the
        // subsidiary shapes the GL and intercompany balancing.
        // An unset subsidiary reads as unset: the empty option
        // must never borrow the root name, or the picker lists "Main Co"
        // twice and the pre-selected entry saves as null.
        if (!multiSub) return null;
        return (
          <>
            <FieldLabel htmlFor={fieldId(p.key)} fieldName={label}>
              {label}
            </FieldLabel>
            {isEditable && !isPosted && config.kind !== "project_charge" ? (
              <SearchSelect
                id={fieldId(p.key)}
                advanceOnSelect
                options={subsidiaryOpts}
                value={subsidiaryId}
                onChange={(v) => setSubsidiaryId(v ?? "")}
                clearable
                placeholder="—"
              />
            ) : (
              <p className="text-sm">{subsidiaryId ? subsidiaryName(subsidiaryId) : "—"}</p>
            )}
          </>
        );
      }
      case "currency":
        // Offered only where the loader passed the organization's currencies
        // (Multi-currency on, a kind that accepts a foreign currency). Fixed
        // once posted: the currency measures every posted amount, so a
        // posted change goes through void-and-reissue.
        if (!offersCurrency) return null;
        return (
          <>
            <FieldLabel htmlFor={fieldId(p.key)} fieldName={label}>
              {label}
            </FieldLabel>
            {isEditable && !isPosted ? (
              <SearchSelect
                id={fieldId(p.key)}
                advanceOnSelect
                options={currencyOptions ?? []}
                value={currency}
                onChange={(v) => {
                  if (!v) return;
                  setCurrency(v);
                  setCurrencyChosen(true);
                }}
              />
            ) : (
              <p className="text-sm">{currency || "—"}</p>
            )}
          </>
        );
      case "payment_hold_reason":
        return (
          <>
            <FieldLabel htmlFor={fieldId(p.key)} fieldName={label}>
              {label}
            </FieldLabel>
            {isEditable ? (
              <Input
                id={fieldId(p.key)}
                value={paymentHoldReason}
                onChange={(e) => setPaymentHoldReason(e.target.value)}
              />
            ) : (
              <p className="text-sm">{doc.payment_hold_reason ?? "—"}</p>
            )}
          </>
        );
      case "internal_notes":
        return (
          <>
            <FieldLabel htmlFor={fieldId(p.key)} fieldName={label}>
              {label}
            </FieldLabel>
            {isEditable ? (
              <Input
                id={fieldId(p.key)}
                value={internalNotes}
                onChange={(e) => setInternalNotes(e.target.value)}
              />
            ) : (
              <p className="text-sm">{doc.internal_notes ?? "—"}</p>
            )}
          </>
        );
      case "billing_method":
        return (
          <>
            <FieldLabel htmlFor={fieldId(p.key)} fieldName={label}>
              {label}
            </FieldLabel>
            {isEditable ? (
              <Select
                id={fieldId(p.key)}
                value={billingMethod}
                onChange={(e) => setBillingMethod(e.target.value)}
              >
                <option value="">—</option>
                <option value="time_and_materials">
                  {tCommon("billingMethods.timeAndMaterials")}
                </option>
                <option value="fixed_price">{tCommon("billingMethods.fixedPrice")}</option>
              </Select>
            ) : (
              <p className="text-sm">
                {doc.billing_method === "time_and_materials"
                  ? tCommon("billingMethods.timeAndMaterials")
                  : doc.billing_method === "fixed_price"
                    ? tCommon("billingMethods.fixedPrice")
                    : "—"}
              </p>
            )}
          </>
        );
      case "is_final_invoice":
        return (
          <>
            <FieldLabel fieldName={label}>{label}</FieldLabel>
            {isEditable ? (
              <label className="flex h-9 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={isFinalInvoice}
                  onChange={(e) => setIsFinalInvoice(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                />
                {tCommon("labels.finalInvoice")}
              </label>
            ) : (
              <p className="text-sm">
                {doc.is_final_invoice ? tCommon("labels.yes") : tCommon("labels.no")}
              </p>
            )}
          </>
        );
      case "control_account":
        if (!controlSide || !controlChoices) return null;
        return (
          <>
            <FieldLabel htmlFor={fieldId(p.key)} fieldName={t("drawer.controlAccount")}>
              {t("drawer.controlAccount")}
            </FieldLabel>
            <SearchSelect
              id={fieldId(p.key)}
              advanceOnSelect
              options={controlChoices.accounts.map((option) => ({
                value: option.id,
                label: controlLabel(option),
                keywords: option.number ? [option.number] : undefined,
              }))}
              value={controlChoice}
              onChange={(value) =>
                setCustomValues((current) => ({ ...current, controlAccountId: value ?? "" }))
              }
              placeholder={controlDefault}
              clearable
              emptyLabel={controlDefault}
            />
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {t("drawer.controlAccountHelp")}
            </p>
          </>
        );
      default:
        if (isCustomFieldKey(p.key)) {
          const defKey = customFieldDefKey(p.key);
          const def = headerDefByDefKey.get(defKey);
          if (!def) return null;
          // The other agent's <CustomFieldInput> renders its own Label + control
          // + help text (and honours displayMode/readOnly), so the layout cell
          // only contributes the col-span placement. A labelOverride on the
          // placement is applied by swapping the def's label for this render.
          const fieldDef = p.labelOverride?.trim()
            ? {
                ...def,
                label: p.labelOverride.trim(),
                isRequired: p.required === true ? true : def.isRequired,
              }
            : p.required === true
              ? { ...def, isRequired: true }
              : def;
          return (
            <CustomFieldInput
              def={fieldDef}
              value={customValues[defKey]}
              onChange={(v) => setCustomValues((c) => ({ ...c, [defKey]: v }))}
              readOnly={!isEditable}
            />
          );
        }
        return null;
    }
  };

  return { cardAccountFallback, pickerPartyRole, partyLabel, partyPlaceholder, renderHeaderField };
}

export type DocumentDrawerHeaderScope = DocumentDrawerColumnsScope &
  ReturnType<typeof useDocumentDrawerHeader>;
