import { sql } from "drizzle-orm";
import { CommerceError } from "./errors.ts";
import { db } from "../platform/db.ts";

/**
 * Channel-neutral catalog matching. A storefront variant resolves to a
 * native item by SKU first (exact, case-insensitive, trimmed), then by
 * barcode against item_identifiers, else it stays queued for the
 * operator. Either side colliding refuses by name with both readings —
 * the engine never guesses which record a SKU meant.
 */

export interface MatchCandidate {
  sku: string | null;
  barcode: string | null;
}

export type CatalogMatch =
  | { kind: "matched"; itemId: string; itemCode: string | null; itemName: string; via: "sku" | "barcode" }
  | { kind: "queued" };

function clean(value: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

interface ItemRow extends Record<string, unknown> {
  id: string;
  code: string | null;
  name: string;
}

export async function matchCatalogVariant(orgId: string, candidate: MatchCandidate): Promise<CatalogMatch> {
  const sku = clean(candidate.sku);
  if (sku) {
    const rows = (
      await db.execute<ItemRow>(sql`
        select id, code, name from items
         where org_id = ${orgId} and lower(code) = lower(${sku})`)
    ).rows;
    if (rows.length > 1) {
      const names = rows.map((row) => `"${row.code ?? row.id}"`).join(", ");
      throw new CommerceError(
        "catalog_sku_ambiguous",
        `SKU "${sku}" matches ${rows.length} items (${names}) and cannot be matched automatically.`,
        "Match the variant by hand on the Products tab, or rename the item codes so the SKU is unique.",
        { field: "sku", status: 409 },
      );
    }
    const hit = rows[0];
    if (hit) return { kind: "matched", itemId: hit.id, itemCode: hit.code, itemName: hit.name, via: "sku" };
  }
  const barcode = clean(candidate.barcode);
  if (barcode) {
    const hit = (
      await db.execute<ItemRow>(sql`
        select i.id, i.code, i.name from item_identifiers ii
          join items i on i.org_id = ii.org_id and i.id = ii.item_id
         where ii.org_id = ${orgId} and ii.value = ${barcode}`)
    ).rows[0];
    if (hit) return { kind: "matched", itemId: hit.id, itemCode: hit.code, itemName: hit.name, via: "barcode" };
  }
  return { kind: "queued" };
}
