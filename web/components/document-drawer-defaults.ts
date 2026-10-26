import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { quoteGoodsPlaceOfSupply } from "@openbooks/engine/tax/contracts";
import { computeLineTaxes } from "@openbooks/engine/tax/tax";
import { readApiErrorMessage } from "../lib/api-error";
import {
  applyLineDefault,
  followTermsDueDate,
  itemChangeRequests,
  type AppliedLineDefault,
  type LineDefaultsContext,
  type ResolvedLineDefault,
} from "./document-line-defaults";
import type { LineRow } from "./document-drawer-types";
import { drawerTaxInputAmount } from "./document-drawer-lines";
import type { DocumentDrawerScope } from "./document-drawer-scope";

/** Tax profiles, line tax, and the item/terms defaults the server resolves. */
export function useDocumentDrawerDefaults(scope: DocumentDrawerScope) {
  const {
    config,
    customValues,
    taxCodes,
    taxGroups,
    documentDate,
    tCommon,
    accounts,
    rows,
    setRows,
    editable,
    partyId,
    isCreate,
    doc,
    dueDate,
    setDueDate,
    dueOverridden,
    setDueOverridden,
    lastDerivedDue,
    setLastDerivedDue,
    parties,
    setNoTermsHint,
  } = scope;
  const nativeGoods =
    config.kind === "customer_invoice" &&
    customValues.canadianGoodsTax &&
    typeof customValues.canadianGoodsTax === "object"
      ? (customValues.canadianGoodsTax as {
          deliveryProvince: string;
          deliveryMethod: string;
          agreementEvidence: string;
        })
      : null;
  const taxProfiles = useMemo(
    () => [
      ...(taxCodes ?? []).map((profile) => ({ ...profile, value: `code:${profile.id}` })),
      ...(taxGroups ?? []).map((profile) => ({ ...profile, value: `group:${profile.id}` })),
    ],
    [taxCodes, taxGroups],
  );
  const taxByProfile = useMemo(
    () => new Map(taxProfiles.map((profile) => [profile.value, profile.tax_components ?? []])),
    [taxProfiles],
  );
  const lineTax = (row: LineRow) => {
    try {
      if (nativeGoods && !row.taxProfileId && !row.taxOverridden)
        return quoteGoodsPlaceOfSupply({
          taxableAmount: String(row.amount),
          quotedOn: documentDate,
          country: "CA",
          deliveryProvince: nativeGoods.deliveryProvince,
          basis: "ordinary_taxable_goods_sale",
        }).taxAmount;
      const taxConfig = taxByProfile.get(row.taxProfileId) ?? [];
      return computeLineTaxes(drawerTaxInputAmount(row, taxConfig), taxConfig).taxTotal;
    } catch {
      return "0.0000";
    }
  };

  // -- pre-save defaults ---------------------------------------------------
  // Choosing an item codes the line with the item's account and the
  // party/item tax code; choosing a party or date derives the due date from
  // the party's payment terms. The server resolves both through the same
  // service the create path applies, and every defaulted field stays
  // editable (see document-line-defaults.ts for the follow rules).
  const fetchDocumentDefaults = useCallback(
    async (request: {
      partyId: string;
      documentDate?: string;
      itemIds?: string[];
    }): Promise<{
      terms: { dueDate: string; source: string | null } | null;
      lines: ResolvedLineDefault[];
    } | null> => {
      const query = new URLSearchParams({ kind: config.kind });
      if (request.partyId) query.set("partyId", request.partyId);
      if (request.documentDate) query.set("documentDate", request.documentDate);
      for (const itemId of request.itemIds ?? []) query.append("itemId", itemId);
      let response: Response;
      try {
        response = await fetch(`/api/documents/defaults?${query.toString()}`, {
          headers: { accept: "application/json" },
        });
      } catch {
        toast.error(tCommon("documentDefaults.failed"));
        return null;
      }
      // The refusal reads through the shared helper so the server's reason
      // renders instead of a bare fallback.
      if (!response.ok) {
        toast.error(await readApiErrorMessage(response, tCommon("documentDefaults.failed")));
        return null;
      }
      const body = (await response.json().catch(() => null)) as {
        terms?: { dueDate?: unknown; source?: unknown } | null;
        lines?: unknown;
      } | null;
      const termsDueDate = typeof body?.terms?.dueDate === "string" ? body.terms.dueDate : null;
      return {
        terms:
          termsDueDate === null
            ? null
            : {
                dueDate: termsDueDate,
                source: typeof body?.terms?.source === "string" ? body.terms.source : null,
              },
        lines: Array.isArray(body?.lines) ? (body.lines as ResolvedLineDefault[]) : [],
      };
    },
    [config.kind, tCommon],
  );

  const seenLineItems = useRef<Map<string, string>>(new Map());
  const appliedLineDefaults = useRef<Map<string, AppliedLineDefault>>(new Map());
  const lineDefaultsContext = useMemo<LineDefaultsContext>(
    () => ({
      accountIds: new Set(accounts.map((account) => account.id)),
      taxProfileValues: new Set(taxProfiles.map((profile) => profile.value)),
      applyTax: config.hasTax && !nativeGoods,
    }),
    [accounts, taxProfiles, config.hasTax, nativeGoods],
  );
  const applyResolvedLineDefaults = useCallback(
    async (requests: { clientKey: string; itemId: string }[], requestPartyId: string) => {
      const result = await fetchDocumentDefaults({
        partyId: requestPartyId,
        itemIds: requests.map((request) => request.itemId),
      });
      if (!result) return;
      const byItem = new Map(result.lines.map((line) => [line.itemId, line]));
      const byKey = new Map(requests.map((request) => [request.clientKey, request.itemId]));
      const previous = new Map(appliedLineDefaults.current);
      setRows((current) =>
        current.map((row) => {
          const itemId = byKey.get(row.clientKey);
          // The operator may have changed the item again while this resolved.
          if (itemId === undefined || row.itemId !== itemId) return row;
          const resolved = byItem.get(itemId) ?? { itemId, accountId: null, taxCodeId: null };
          const next = applyLineDefault(
            row,
            resolved,
            previous.get(row.clientKey),
            lineDefaultsContext,
          );
          appliedLineDefaults.current.set(row.clientKey, next.applied);
          return next.row;
        }),
      );
    },
    [fetchDocumentDefaults, lineDefaultsContext, setRows],
  );

  useEffect(() => {
    if (!config.lineDefaults) return;
    const { requests, seen } = itemChangeRequests(seenLineItems.current, rows);
    seenLineItems.current = seen;
    if (editable && requests.length > 0) void applyResolvedLineDefaults(requests, partyId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, editable, config.lineDefaults]);

  // A party change re-resolves lines still carrying a default the drawer
  // applied (the party's tax code takes precedence over the item's).
  const lineDefaultsParty = useRef(partyId);
  useEffect(() => {
    if (lineDefaultsParty.current === partyId) return;
    lineDefaultsParty.current = partyId;
    if (!editable || !config.lineDefaults) return;
    const requests = rows
      .filter((row) => row.itemId !== "" && appliedLineDefaults.current.has(row.clientKey))
      .map((row) => ({ clientKey: row.clientKey, itemId: row.itemId }));
    if (requests.length > 0) void applyResolvedLineDefaults(requests, partyId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partyId]);

  // A persisted draft's first resolution only calibrates: opening it never
  // rewrites a saved due date.
  const initialTermsKey = useRef<string | null>(
    isCreate ? null : `${doc.party_id ?? ""}|${doc.document_date ?? ""}`,
  );
  // The resolution settles against the due date as it is when the answer
  // arrives, not as it was when the request left.
  const dueState = useRef({ dueDate, overridden: dueOverridden });
  useEffect(() => {
    dueState.current = { dueDate, overridden: dueOverridden };
  }, [dueDate, dueOverridden]);
  const termsIdentity = JSON.stringify([partyId, documentDate, editable, config.dueDateFromTerms]);
  const [observedTermsIdentity, setObservedTermsIdentity] = useState(termsIdentity);
  if (observedTermsIdentity !== termsIdentity) {
    setObservedTermsIdentity(termsIdentity);
    if (
      !partyId &&
      config.dueDateFromTerms &&
      editable &&
      /^\d{4}-\d{2}-\d{2}$/.test(documentDate)
    ) {
      const next = followTermsDueDate({
        dueDate,
        overridden: dueOverridden,
        lastDerived: lastDerivedDue,
        derived: null,
      });
      if (next !== dueDate) setDueDate(next);
      setLastDerivedDue(null);
    }
  }
  useEffect(() => {
    if (!config.dueDateFromTerms || !editable || !/^\d{4}-\d{2}-\d{2}$/.test(documentDate)) return;
    const calibrateOnly = initialTermsKey.current === `${partyId}|${documentDate}`;
    let cancelled = false;
    const settle = (derived: string | null) => {
      if (cancelled) return;
      const current = dueState.current;
      if (calibrateOnly) {
        if (derived !== null && current.dueDate === derived) setDueOverridden(false);
      } else {
        const next = followTermsDueDate({
          dueDate: current.dueDate,
          overridden: current.overridden,
          lastDerived: lastDerivedDue,
          derived,
        });
        if (next !== current.dueDate) setDueDate(next);
        if (derived !== null && next === derived) setDueOverridden(false);
      }
      setLastDerivedDue(derived);
    };
    if (!partyId) {
      return;
    }
    void fetchDocumentDefaults({ partyId, documentDate }).then((result) => {
      if (!result) return;
      // A resolved answer with no terms means neither the party nor the
      // company default names usable terms: name the counterparty so the
      // operator knows where to set them. A failed fetch shows no hint.
      if (result.terms === null) {
        const name = (parties ?? []).find((p) => p.id === partyId)?.display_name?.trim();
        setNoTermsHint(name ? name : tCommon("documentDefaults.unnamedParty"));
      } else setNoTermsHint(null);
      settle(result.terms?.dueDate ?? null);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partyId, documentDate, editable, config.dueDateFromTerms, setNoTermsHint]);

  /** An operator-typed due date (or an explicit clear) stops following the terms. */
  const editDueDate = (value: string) => {
    setDueDate(value);
    setDueOverridden(value === "" || value !== lastDerivedDue);
  };

  return { nativeGoods, taxProfiles, taxByProfile, lineTax, editDueDate };
}

export type DocumentDrawerDefaultsScope = DocumentDrawerScope &
  ReturnType<typeof useDocumentDrawerDefaults>;
