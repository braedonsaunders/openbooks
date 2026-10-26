import { taxProfileMap } from "@openbooks/engine/documents/totals";
import { isIsoCalendarDate } from "@openbooks/engine/platform/iso-date";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { notFound } from "@/lib/api/responses";
import { db } from "@openbooks/engine/platform/db";
import {
  DocumentDefaultsError,
  resolveDocumentLineDefaults,
  resolvePartyLineDefault,
  resolveRecentPartyDocument,
  resolveTermsDueDate,
} from "@openbooks/engine/ledger/document-defaults";
import { getAuthz, guardPermission } from "@/lib/authz";
import { isDocKindEnabled } from "@/lib/documents.ts";
import { DOC_KINDS, documentEditPermission } from "@/lib/document-kinds.ts";

const DefaultsQuerySchema = z.object({
  kind: z.enum(Object.keys(DOC_KINDS) as [string, ...string[]]),
  partyId: uuidString().optional(),
  documentDate: z.string().refine(isIsoCalendarDate).optional(),
  itemIds: z.array(uuidString()).max(200),
  include: z.array(z.enum(["party", "tax"])).max(2),
});

export const runtime = "nodejs";

/**
 * Header and line defaults for a document being edited, before it is saved:
 * the due date the party's payment terms imply (`documentDate` + `partyId`),
 * and each `itemId`'s account and tax code. Read-only — the same resolver the
 * create path applies — so the drawer shows exactly what the server derives.
 *
 * `include=party` adds `party` (null without a `partyId`): the account and tax
 * code an item-less line takes for that party (its default, else its own
 * history as of `documentDate`), and its most recent document of the kind for
 * recall. Both stay inside the caller's subsidiary scope. `include=tax`
 * returns the native tax components effective on the document date, so
 * batch control totals use the same rates as the persisted bills.
 */
export const GET = defineRoute({
  authorize: async ({ request }) => {
    const session = await getAuthz();
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const params = new URL(request.url).searchParams;
    const parsed = DefaultsQuerySchema.safeParse({
      kind: params.get("kind") ?? undefined,
      partyId: params.get("partyId") || undefined,
      documentDate: params.get("documentDate") || undefined,
      itemIds: params.getAll("itemId"),
      include: params.getAll("include"),
    });
    if (!parsed.success) return session;
    return guardPermission(documentEditPermission(parsed.data.kind));
  },
  feature: { none: "The selected document kind determines its permission and feature access." },
  handler: async ({ request, authz: gate }) => {
    const params = new URL(request.url).searchParams;
    const parsed = DefaultsQuerySchema.safeParse({
      kind: params.get("kind") ?? undefined,
      partyId: params.get("partyId") || undefined,
      documentDate: params.get("documentDate") || undefined,
      itemIds: params.getAll("itemId"),
      include: params.getAll("include"),
    });
    if (!parsed.success) {
      return NextResponse.json(
        {
          error:
            "Name a document kind, and use a valid party, document date (YYYY-MM-DD), item ids and include=party or include=tax",
        },
        { status: 400 },
      );
    }
    const query = parsed.data;
    const orgId = gate.user.orgId;
    if (!(await isDocKindEnabled(orgId, query.kind))) return notFound("record");
    const partyId = query.partyId;
    const scope = gate.allowedSubsidiaryIds;
    const includeParty = query.include.includes("party");
    try {
      const [terms, lines, party, taxes] = await Promise.all([
        query.documentDate
          ? resolveTermsDueDate(db, orgId, {
              kind: query.kind,
              partyId,
              documentDate: query.documentDate,
            })
          : Promise.resolve(null),
        resolveDocumentLineDefaults(db, orgId, {
          kind: query.kind,
          partyId,
          itemIds: query.itemIds,
        }),
        includeParty && partyId
          ? Promise.all([
              resolvePartyLineDefault(db, orgId, {
                kind: query.kind,
                partyId,
                asOfDate: query.documentDate,
                allowedSubsidiaryIds: scope,
              }),
              resolveRecentPartyDocument(db, orgId, {
                kind: query.kind,
                partyId,
                allowedSubsidiaryIds: scope,
              }),
            ]).then(([line, recent]) => ({ line, recent }))
          : Promise.resolve(null),
        query.include.includes("tax")
          ? taxProfileMap(orgId, query.documentDate)
          : Promise.resolve(null),
      ]);
      return NextResponse.json({
        terms,
        lines,
        ...(includeParty ? { party } : {}),
        ...(taxes
          ? {
              taxes: {
                codes: Object.fromEntries(taxes.codes),
                groups: Object.fromEntries(taxes.groups),
              },
            }
          : {}),
      });
    } catch (error) {
      if (error instanceof DocumentDefaultsError) return apiErrorResponse(error);
      throw error;
    }
  },
});
