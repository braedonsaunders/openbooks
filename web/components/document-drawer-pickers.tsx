import { useEffect, useMemo, useState } from "react";
import { Badge } from "@openbooks/ui";
import { normalizeMoney } from "@openbooks/engine/money/money";
import { quoteGoodsPlaceOfSupply } from "@openbooks/engine/tax/contracts";
import type { LineGridColumn } from "./line-grid";
import type { LineRow, ReturnableSourceOption } from "./document-drawer-types";
import {
  NO_RETURN_SENTINEL,
  computeDocumentDrawerTotals,
  isBlankDrawerLine,
  type DocumentDrawerTotals,
} from "./document-drawer-lines";
import type { DocumentDrawerDistributionScope } from "./document-drawer-distribution";

/**
 * Footer totals, subsidiary choice, and the server-backed pickers: return
 * sources, the receivable/payable control account, promotion and
 * marketplace line columns.
 */
export function useDocumentDrawerPickers(scope: DocumentDrawerDistributionScope) {
  const {
    editable,
    isTransfer,
    transfer,
    config,
    rows,
    nativeGoods,
    documentDate,
    taxByProfile,
    totals,
    subsidiaries,
    setPartyId,
    isDraft,
    parties,
    setSubsidiaryId,
    offersCurrency,
    partyRoleCurrency,
    currencyChosen,
    setCurrency,
    items,
    recordType,
    isCreate,
    partyId,
    subsidiaryId,
    customValues,
    doc,
    t,
    promotionsEnabled,
    tSales,
    marketplaceFacilitators,
  } = scope;
  const calculatedTotals = useMemo<DocumentDrawerTotals | null>(() => {
    if (!editable) return null;
    if (isTransfer) {
      try {
        const amount = normalizeMoney(String(transfer?.amount ?? ""));
        return { subtotal: amount, taxTotal: "0.0000", total: amount };
      } catch {
        return { subtotal: "0.0000", taxTotal: "0.0000", total: "0.0000" };
      }
    }
    // Project-charge lines are immutable here; their source editor owns the
    // rate snapshot and the server-provided totals remain authoritative.
    if (config.kind === "project_charge") return null;
    let previewRows = rows;
    try {
      previewRows = nativeGoods
        ? rows.map((row) =>
            !row.taxProfileId && !row.taxOverridden && !isBlankDrawerLine(row)
              ? {
                  ...row,
                  taxOverridden: true,
                  taxAmount: quoteGoodsPlaceOfSupply({
                    taxableAmount: String(row.amount),
                    quotedOn: documentDate,
                    country: "CA",
                    deliveryProvince: nativeGoods.deliveryProvince,
                    basis: "ordinary_taxable_goods_sale",
                  }).taxAmount,
                }
              : row,
          )
        : rows;
    } catch {
      return null;
    }
    return computeDocumentDrawerTotals(previewRows, taxByProfile, config.hasTax);
  }, [
    editable,
    isTransfer,
    transfer,
    config.kind,
    config.hasTax,
    rows,
    taxByProfile,
    nativeGoods,
    documentDate,
  ]);
  const effectiveTotals = calculatedTotals ?? totals;

  // -- subsidiaries (multi-subsidiary orgs only; empty/undefined = no UI) ----
  const multiSub = (subsidiaries?.length ?? 0) > 0;
  const subsidiaryOpts = useMemo(
    () =>
      (subsidiaries ?? []).map((s) => ({ value: s.id, label: "\u2003".repeat(s.depth) + s.name })),
    [subsidiaries],
  );
  const subsidiaryName = (id: unknown): string =>
    (subsidiaries ?? []).find((s) => s.id === id)?.name ?? "—";
  /**
   * Picking a party on a draft defaults the document's subsidiary to the
   * party's primary, and — until a currency is chosen explicitly — the
   * document currency to the party's role currency, else the currency the
   * document opened in.
   */
  const changeParty = (v: string | null | undefined) => {
    setPartyId(v ?? "");
    if (multiSub && isDraft && v) {
      const sub = (parties ?? []).find((p) => p.id === v)?.subsidiary_id;
      if (sub) setSubsidiaryId(sub);
    }
    if (offersCurrency && isDraft && !currencyChosen) {
      setCurrency(partyRoleCurrency(v) ?? String(doc.currency ?? ""));
    }
  };

  // Stocked lines relieve a warehouse at posting, so a customer invoice for
  // stocked goods must name one per line. The picker appears only when the
  // choice is real (several active locations) and only on stocked rows; a
  // single location is stamped silently by the edit writer instead.
  const stockedItemIds = useMemo(
    () =>
      new Set(
        (items ?? []).filter((item) => item.has_inventory_profile === true).map((item) => item.id),
      ),
    [items],
  );
  // A credit memo may return stock. The engine settles the return against the
  // posted movement the goods left or arrived on, so the operator picks that
  // movement here; a vendor row may instead be recorded as an allowance with
  // no goods returned. A blank vendor row is refused on save (a stocked line
  // must choose), while a blank sales row stays a purely financial credit.
  // The same reader answers this list and the save-time check, so the picker
  // cannot offer a source the save refuses.
  const returnSide =
    recordType === "vendor_credit"
      ? "purchase"
      : recordType === "customer_credit" ||
          recordType === "cash_refund" ||
          (recordType === "rma" && isCreate)
        ? "sales"
        : null;
  const returnRowsKey = rows
    .map((row) => `${row.itemId}:${row.stockLocationId}`)
    .filter((key) => key !== ":")
    .join("|");
  const [returnSources, setReturnSources] = useState<ReturnableSourceOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    const run = async (): Promise<void> => {
      if (
        !returnSide ||
        !partyId ||
        returnRowsKey === "" ||
        (recordType === "rma" && !subsidiaryId)
      ) {
        if (!cancelled) setReturnSources([]);
        return;
      }
      try {
        const sourcePath =
          recordType === "rma"
            ? `/api/returns/sources?partyId=${encodeURIComponent(partyId)}&subsidiaryId=${encodeURIComponent(subsidiaryId ?? "")}&limit=200`
            : `/api/inventory/returnable-sources?side=${returnSide}&kind=${encodeURIComponent(String(recordType))}&partyId=${encodeURIComponent(partyId)}&limit=200`;
        const res = await fetch(sourcePath);
        // Inventory off, credit kind off, or no permission: no picker, and no
        // console noise for a refusal the drawer already knows how to absorb.
        if (!res.ok) {
          if (!cancelled) setReturnSources([]);
          return;
        }
        const body = (await res.json()) as { sources?: ReturnableSourceOption[] };
        if (!cancelled) setReturnSources(Array.isArray(body.sources) ? body.sources : []);
      } catch {
        if (!cancelled) setReturnSources([]);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [returnSide, partyId, returnRowsKey, recordType, subsidiaryId]);

  // -- receivable/payable account (party documents) ------------------------
  // Invoices, credit memos, bills and vendor credits post their open item to
  // the document's own choice, else the party default, else the organization
  // control account. The picker lists the accounts the edit boundary accepts
  // and names what an empty choice resolves to; a posted document shows the
  // account its open item actually carries. The server re-validates both.
  const controlSide: "ar" | "ap" | null =
    config.isOpenItem && (config.family === "ar" || config.family === "ap") ? config.family : null;
  const controlChoice =
    typeof customValues.controlAccountId === "string" ? customValues.controlAccountId : "";
  type ControlOption = { id: string; number: string | null; name: string };
  const [controlChoices, setControlChoices] = useState<{
    accounts: ControlOption[];
    intercompany?: ControlOption | null;
    partyDefault: ControlOption | null;
    organizationDefault: ControlOption | null;
    selected: ControlOption | null;
    posted: ControlOption | null;
  } | null>(null);
  useEffect(() => {
    if (!controlSide) return;
    let cancelled = false;
    const params = new URLSearchParams({ kind: String(config.kind) });
    if (partyId) params.set("partyId", partyId);
    if (subsidiaryId) params.set("subsidiaryId", subsidiaryId);
    if (controlChoice) params.set("accountId", controlChoice);
    if (typeof doc.id === "string" && doc.id) params.set("documentId", doc.id);
    fetch(`/api/documents/control-account?${params.toString()}`)
      .then(async (res) => {
        if (cancelled) return;
        // A reader without access simply sees no picker; posting and the
        // edit boundary still resolve and validate the account. A response
        // without the account list is not a picker either: the drawer keeps
        // rendering rather than failing on a malformed payload.
        const payload: unknown = res.ok ? await res.json().catch(() => null) : null;
        if (cancelled) return;
        setControlChoices(
          payload &&
            typeof payload === "object" &&
            Array.isArray((payload as { accounts?: unknown }).accounts)
            ? (payload as NonNullable<typeof controlChoices>)
            : null,
        );
      })
      .catch(() => {
        if (!cancelled) setControlChoices(null);
      });
    return () => {
      cancelled = true;
    };
  }, [controlSide, config.kind, partyId, subsidiaryId, controlChoice, doc.id, doc.status]);
  const controlLabel = (option: ControlOption | null | undefined): string =>
    option ? `${option.number ? `${option.number} · ` : ""}${option.name}` : "";
  // Only open-item documents carry a control-account choice, and only their
  // catalogs define its copy.
  const controlDefault = !controlSide
    ? ""
    : controlChoices?.intercompany
      ? t("drawer.controlAccountIntercompany", {
          account: controlLabel(controlChoices.intercompany),
        })
      : controlChoices?.partyDefault
        ? t("drawer.controlAccountPartyDefault", {
            account: controlLabel(controlChoices.partyDefault),
          })
        : controlChoices?.organizationDefault
          ? t("drawer.controlAccountOrganizationDefault", {
              account: controlLabel(controlChoices.organizationDefault),
            })
          : t("drawer.controlAccountUnset");
  // A vendor credit always offers the choice: even with no returnable
  // receipt in the list the operator can still record the line as an
  // allowance (no goods returned). An allowance moves no stock, so the row
  // needs no warehouse before choosing — a warehouseless stocked row still
  // counts here, or a draft saved before its location was stamped could
  // never reach the choice the save requires. Sales credits keep the picker
  // list-gated.
  const hasStockedReturnRows = rows.some((row) => stockedItemIds.has(String(row.itemId ?? "")));
  const showReturnPicker =
    returnSide !== null &&
    (returnSources.length > 0 || (returnSide === "purchase" && hasStockedReturnRows));
  const returnSourceColumn = useMemo<LineGridColumn<LineRow> | null>(() => {
    if (!showReturnPicker) return null;
    // A blank vendor row is an unfinished choice, not a financial line: the
    // save refuses it with the receipt-or-allowance message. Sales rows keep
    // the standing "no stock returned" blank.
    const blankOption = {
      value: "",
      label: returnSide === "purchase" ? t("drawer.returnsChoose") : t("drawer.returnsNone"),
    };
    const allowanceOption =
      returnSide === "purchase"
        ? [{ value: NO_RETURN_SENTINEL, label: t("drawer.returnsNoGoods") }]
        : [];
    const sourceLabel = (source: ReturnableSourceOption): string =>
      `${source.documentNumber ?? source.movedAt} · ${source.remaining}${
        source.lotCode ? ` · ${source.lotCode}` : source.serialCode ? ` · ${source.serialCode}` : ""
      }`;
    return {
      key: "returnSourceMovementId",
      label: returnSide === "purchase" ? t("drawer.returnsReceipt") : t("drawer.returnsShipment"),
      width: "190px",
      type: "select",
      options: [
        blankOption,
        ...allowanceOption,
        ...returnSources.map((source) => ({
          value: source.movementId,
          label: sourceLabel(source),
        })),
      ],
      // A vendor allowance moves no stock, so a stocked row chooses even
      // before its warehouse is known (the save stamps a single-warehouse
      // default, and refuses a receipt choice on a warehouseless row by
      // line name). Other credit kinds keep the standing warehouse gate.
      isCellEditable: (row) =>
        stockedItemIds.has(String(row.itemId ?? "")) &&
        (returnSide === "purchase" || String(row.stockLocationId ?? "") !== ""),
      optionsFor: (row) => [
        blankOption,
        ...allowanceOption,
        ...returnSources
          .filter(
            (source) =>
              source.itemId === String(row.itemId ?? "") &&
              source.stockLocationId === String(row.stockLocationId ?? ""),
          )
          .map((source) => ({
            value: source.movementId,
            label: sourceLabel(source),
          })),
      ],
    };
  }, [showReturnPicker, returnSide, returnSources, stockedItemIds, t]);

  // -- promotion chip --------------------------------------------------------
  // Discount lines applied from a promotion carry its code; the column shows
  // only when a row actually carries one, so ordinary documents keep their
  // exact grid.
  const showPromotionColumn =
    promotionsEnabled === true && rows.some((row) => String(row.promotionCode ?? "") !== "");
  const promotionColumn = useMemo<LineGridColumn<LineRow> | null>(() => {
    if (!showPromotionColumn) return null;
    return {
      key: "promotionCode",
      label: tSales("promotion.chip"),
      width: "130px",
      type: "readonly",
      render: (row) => {
        const code = String(row.promotionCode ?? "");
        if (code === "") return null;
        return <Badge variant="secondary">{code}</Badge>;
      },
    };
  }, [showPromotionColumn, tSales]);

  // Who collects the line's tax: the merchant, or a marketplace facilitator
  // (whose share posts to its clearing account, never the tax liability).
  // Paid-at-sale kinds ride alongside invoices and credits. The engine kind
  // map is the server's copy of this set. No facilitators configured, no
  // column: with nothing to choose, the choice is not offered.
  const marketplaceColumn = useMemo<LineGridColumn<LineRow> | null>(() => {
    if (
      config.kind !== "customer_invoice" &&
      config.kind !== "customer_credit" &&
      config.kind !== "cash_sale" &&
      config.kind !== "cash_refund"
    )
      return null;
    if (marketplaceFacilitators.length === 0) return null;
    return {
      key: "marketplaceFacilitator",
      label: t("drawer.marketplaceCollectedBy"),
      help: t("drawer.marketplaceCollectedByHelp"),
      width: "170px",
      type: "select",
      options: [
        { value: "", label: t("drawer.marketplaceMerchant") },
        ...marketplaceFacilitators.map((facilitator) => ({
          value: facilitator.name,
          label: facilitator.name,
        })),
      ],
      // A line with no tax profile computes no tax, so there is nothing for
      // a facilitator to collect: do not offer the choice before then.
      isCellEditable: (row) => row.taxProfileId !== "" || row.taxOverridden === true,
    };
  }, [config.kind, marketplaceFacilitators, t]);

  return {
    calculatedTotals,
    effectiveTotals,
    multiSub,
    subsidiaryOpts,
    subsidiaryName,
    changeParty,
    stockedItemIds,
    returnSources,
    controlSide,
    controlChoice,
    controlChoices,
    controlLabel,
    controlDefault,
    returnSourceColumn,
    promotionColumn,
    marketplaceColumn,
  };
}

export type DocumentDrawerPickersScope = DocumentDrawerDistributionScope &
  ReturnType<typeof useDocumentDrawerPickers>;
