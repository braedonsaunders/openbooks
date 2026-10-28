import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import { z } from "zod";
import { isFeatureEnabled } from "./features";
import {
  validateRateBookLines,
  type RateBookInputLine,
  type ValidRateBookLine,
} from "./item-rate-book-lines";
import { validateTimeTypeBillRates } from "./item-rate-time-types";
import { isUuid } from "./list-params";
import { saveSetupBook } from "./setup/books";
import { resolveSetupEntity } from "./setup/write";
import { notFound } from "./api/responses";

import type { Authz } from "./authz";

export const rateBookBody = z.object({
  id: z.string().optional().describe("Existing rate-book id to update, or omit to create a book."),
  code: z.string().trim().min(1).describe("Unique rate-book code."),
  name: z.string().trim().min(1).describe("Rate-book display name."),
  currency: z.string().optional().describe("Book currency; requires multi-currency to be enabled."),
  isDefault: z
    .boolean()
    .optional()
    .describe("Whether this is the organization's default rate book."),
  isActive: z.boolean().optional().describe("Whether the rate book is active."),
  replaceRates: z
    .boolean()
    .optional()
    .describe("Create a new effective-dated version from the supplied lines."),
  confirmEmptyReplacement: z
    .boolean()
    .optional()
    .describe("Confirm that an empty replacement intentionally ends every rate in this book."),
  effectiveFrom: z
    .string()
    .optional()
    .describe("Start date for the replacement version in YYYY-MM-DD format."),
  effectiveTo: z
    .string()
    .nullable()
    .optional()
    .describe("Optional end date for the replacement version."),
  laborDerivationPolicy: z
    .enum(["explicit", "time_type_multipliers"])
    .optional()
    .describe("Labor rate derivation policy for the new version."),
  lines: z
    .array(
      z
        .object({
          itemId: z.string().optional().describe("Item id from search_items or get_item."),
          unitCode: z.string().optional().describe("Rate unit code."),
          unitName: z.string().optional().describe("Rate unit display name."),
          baseQuantity: z
            .string()
            .optional()
            .describe("Exact positive quantity for this rate unit."),
          costRate: z
            .string()
            .nullable()
            .optional()
            .describe("Exact non-negative cost rate, or null when not supplied."),
          billRate: z.string().optional().describe("Exact non-negative bill rate."),
          baseUnit: z.string().optional().describe("Base unit inherited by the item rate profile."),
          pricingPolicy: z.string().optional().describe("Pricing policy for this item."),
          invoicePresentation: z
            .string()
            .optional()
            .describe("Invoice presentation for this item."),
          timeTypeBillRates: z
            .record(z.string(), z.string())
            .optional()
            .describe("Exact per-time-type bill rates keyed by active time-type id."),
        })
        .describe("One item's rate lines and profile for the new version."),
    )
    .optional()
    .describe("Complete rate lines for the new version when replaceRates is true."),
});

const INVENTORY_KINDS = new Set(["inventory", "assembly", "kit"]);

function databaseCode(error: unknown): string | undefined {
  const value = error as { code?: string; cause?: { code?: string } };
  return value.cause?.code ?? value.code;
}

export async function saveItemRateBook(
  body: z.infer<typeof rateBookBody>,
  gate: Authz,
): Promise<Response> {
  // Rate books and their versions price every entity with no subsidiary
  // lineage of their own: a restricted caller must not rewrite them.
  const id = body.id == null || body.id === "" ? null : String(body.id);
  if (id && !isUuid(id))
    return NextResponse.json({ error: "Rate book not found." }, { status: 404 });
  const code = String(body.code ?? "").trim();
  const name = String(body.name ?? "").trim();
  if (!code) return NextResponse.json({ error: "Code is required." }, { status: 422 });
  if (!name) return NextResponse.json({ error: "Name is required." }, { status: 422 });

  const replaceRates = body.replaceRates === true;
  if (body.laborDerivationPolicy !== undefined && !replaceRates) {
    return NextResponse.json(
      { error: "Changing labor pricing requires a new effective-dated rate version." },
      { status: 422 },
    );
  }
  const effectiveFrom = String(body.effectiveFrom ?? "");
  const effectiveTo = body.effectiveTo?.trim() || null;
  const validated = replaceRates
    ? validateRateBookLines(body.lines)
    : { lines: [] as ValidRateBookLine[] };
  if ("error" in validated) return NextResponse.json({ error: validated.error }, { status: 422 });
  if (replaceRates && !isIsoCalendarDate(effectiveFrom)) {
    return NextResponse.json(
      { error: "Effective from must be a real calendar date in YYYY-MM-DD format." },
      { status: 422 },
    );
  }
  if (
    replaceRates &&
    effectiveTo !== null &&
    (!isIsoCalendarDate(effectiveTo) || effectiveTo < effectiveFrom)
  ) {
    return NextResponse.json(
      {
        error:
          "Effective to must be a real calendar date on or after effective from, or empty for an open-ended version.",
      },
      { status: 422 },
    );
  }
  // Activating a version with zero lines would silently wipe every rate in
  // the book from the new date. Refuse it unless the operator explicitly
  // confirmed clearing all rates; the check runs before the transaction, so
  // a refusal leaves the current active version untouched.
  if (replaceRates && validated.lines.length === 0 && body.confirmEmptyReplacement !== true) {
    return NextResponse.json(
      {
        error: `A replacement with no rate lines would clear every rate in this book from ${effectiveFrom}. Confirm that all rates should end, then save again.`,
      },
      { status: 422 },
    );
  }
  // Per-time-type premiums validate through the shared validator: every key
  // must be an active time type of this org and every value valid money.
  // Anything else refuses by row and key with no write — never filtered
  // silently. The maps run over the raw input in order so labels name the
  // submitted row; validated lines take their premiums by row number.
  if (replaceRates) {
    const premiumMaps = (body.lines as RateBookInputLine[]).map((raw, index) => ({
      label: `Row ${index + 1}`,
      raw: raw?.timeTypeBillRates,
    }));
    const validatedPremiums = await validateTimeTypeBillRates(gate.user.orgId, premiumMaps);
    if ("error" in validatedPremiums)
      return NextResponse.json({ error: validatedPremiums.error }, { status: 422 });
    for (const line of validated.lines) {
      line.timeTypeBillRates = validatedPremiums.rates[line.rowNumber - 1] ?? {};
    }
  }

  const multiCurrency = await isFeatureEnabled(gate.user.orgId, "multiCurrency");
  if (body.currency !== undefined && !multiCurrency) return notFound("record");
  const inventoryEnabled = await isFeatureEnabled(gate.user.orgId, "inventory");
  const equipmentEnabled = await isFeatureEnabled(gate.user.orgId, "equipment");
  const entity = resolveSetupEntity("item-rate-books");
  if (!entity)
    return NextResponse.json({ error: "Rate book configuration is unavailable." }, { status: 500 });

  try {
    const result = await db.transaction(async (tx) => {
      const bookId = await saveSetupBook(
        entity,
        gate.user.orgId,
        gate.user.id,
        {
          code,
          name,
          ...(body.currency !== undefined ? { currency: String(body.currency) } : {}),
          ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
          isActive: body.isActive !== false,
        },
        tx,
        id ? { id } : {},
      );
      if (!bookId) throw new Error("Rate book was not saved.");
      if (!replaceRates) return { id: bookId };

      const latest = (
        await tx.execute<{ id: string; effective_from: string; effective_to: string | null }>(
          sql`
        select id, effective_from, effective_to
          from item_rate_versions
         where org_id = ${gate.user.orgId} and rate_book_id = ${bookId} and status = 'active'
         order by effective_from desc
         limit 1
         for update`,
          "objects",
        )
      )[0];
      if (latest && effectiveFrom <= String(latest.effective_from).slice(0, 10)) {
        throw new Error(
          `The new rate version must start after ${String(latest.effective_from).slice(0, 10)}. Choose a later effective date.`,
        );
      }
      const previousLaborPolicy = latest
        ? (
            await tx.execute<{ derivation_policy: "explicit" | "time_type_multipliers" }>(
              sql`
            select derivation_policy from labor_rate_version_policies
             where org_id = ${gate.user.orgId} and version_id = ${latest.id}`,
              "objects",
            )
          )[0]
        : undefined;
      // Replacing prices retains the book's labor registration unless the
      // operator explicitly changes its policy on this new version.
      const laborDerivationPolicy =
        body.laborDerivationPolicy ?? previousLaborPolicy?.derivation_policy;

      const itemIds = [...new Set(validated.lines.map((line) => line.itemId))];
      const itemRows = itemIds.length
        ? await tx.execute<{ id: string; kind: string }>(
            sql`
            select id, kind from items
             where org_id = ${gate.user.orgId} and id in (${sql.join(
               itemIds.map((itemId) => sql`${itemId}`),
               sql`, `,
             )})
             for update`,
            "objects",
          )
        : [];
      if (itemRows.length !== itemIds.length)
        throw new Error(
          "One or more selected items no longer exist in this organization. Remove them and save again.",
        );
      const previousItemIds = latest
        ? new Set(
            (
              await tx.execute<{ item_id: string }>(
                sql`
            select distinct item_id from item_rate_lines
             where org_id = ${gate.user.orgId} and version_id = ${latest.id}`,
                "objects",
              )
            ).map((row) => String(row.item_id)),
          )
        : new Set<string>();
      for (const item of itemRows) {
        if (
          !inventoryEnabled &&
          INVENTORY_KINDS.has(item.kind) &&
          !previousItemIds.has(String(item.id))
        ) {
          throw new Error(
            "Inventory must be enabled before adding an inventory, assembly, or kit item to a rate book.",
          );
        }
        if (
          !equipmentEnabled &&
          item.kind === "equipment_charge" &&
          !previousItemIds.has(String(item.id))
        ) {
          throw new Error(
            "Equipment must be enabled before adding an equipment-charge item to a rate book.",
          );
        }
      }

      // A new version may shorten an existing window, never extend an expired
      // version across a deliberately unpriced gap.
      let closedVersion: {
        id: string;
        before: { effectiveTo: string | null };
        after: { effectiveTo: string };
      } | null = null;
      if (
        latest &&
        (latest.effective_to === null || effectiveFrom <= String(latest.effective_to).slice(0, 10))
      ) {
        const closed = await tx.execute<{ id: string; effective_to: string }>(
          sql`
          update item_rate_versions
             set effective_to = (${effectiveFrom}::date - interval '1 day')::date,
                 updated_at = now(), updated_by = ${gate.user.id}
           where id = ${latest.id} and org_id = ${gate.user.orgId} and status = 'active'
           returning id, effective_to::text`,
          "objects",
        );
        if (closed.length !== 1)
          throw new Error(
            "The current rate version changed while you were editing. Reload the rate book and try again.",
          );
        closedVersion = {
          id: latest.id,
          before: {
            effectiveTo:
              latest.effective_to === null ? null : String(latest.effective_to).slice(0, 10),
          },
          after: { effectiveTo: closed[0]!.effective_to },
        };
      }

      const version = (
        await tx.execute<{ id: string }>(
          sql`
        insert into item_rate_versions (org_id, rate_book_id, effective_from, effective_to, status, created_by, updated_by)
        values (${gate.user.orgId}, ${bookId}, ${effectiveFrom}, ${effectiveTo}, 'draft', ${gate.user.id}, ${gate.user.id})
        returning id`,
          "objects",
        )
      )[0];
      if (!version) throw new Error("The new rate version was not created.");

      let laborPolicy: Record<string, unknown> | null = null;
      if (laborDerivationPolicy !== undefined) {
        const policies = await tx.execute<Record<string, unknown>>(
          sql`
          insert into labor_rate_version_policies (org_id, version_id, derivation_policy, created_by, updated_by)
          values (${gate.user.orgId}, ${version.id}, ${laborDerivationPolicy}, ${gate.user.id}, ${gate.user.id})
          returning *`,
          "objects",
        );
        if (policies.length !== 1)
          throw new Error(
            "The labor pricing policy was not saved. Reload the rate book and try again.",
          );
        laborPolicy = policies[0]!;
      }

      const seenProfiles = new Set<string>();
      for (const line of validated.lines) {
        if (!seenProfiles.has(line.itemId)) {
          const profile = await tx.execute(
            sql`
            insert into item_rate_profiles (
              org_id, item_id, base_unit, pricing_policy, invoice_presentation, is_active, created_by, updated_by
            ) values (
              ${gate.user.orgId}, ${line.itemId}, ${line.baseUnit}, ${line.pricingPolicy}, ${line.invoicePresentation}, true, ${gate.user.id}, ${gate.user.id}
            )
            on conflict (org_id, item_id) do update
              set base_unit = excluded.base_unit,
                  pricing_policy = excluded.pricing_policy,
                  invoice_presentation = excluded.invoice_presentation,
                  is_active = true,
                  updated_at = now(),
                  updated_by = excluded.updated_by
              where item_rate_profiles.org_id = ${gate.user.orgId}
            returning id`,
            "objects",
          );
          if (profile.length !== 1)
            throw new Error(
              "An item rate profile was not saved. Reload the rate book and try again.",
            );
          // Pin this item's behavior to the new version. The profile row
          // above keeps only the defaults for future versions; resolution
          // reads this pin, so a later policy switch cannot reprice it.
          const pinned = await tx.execute(
            sql`
            insert into item_rate_version_profiles (org_id, version_id, item_id, base_unit, pricing_policy, invoice_presentation, created_by, updated_by)
            values (${gate.user.orgId}, ${version.id}, ${line.itemId}, ${line.baseUnit}, ${line.pricingPolicy}, ${line.invoicePresentation}, ${gate.user.id}, ${gate.user.id})
            returning id`,
            "objects",
          );
          if (pinned.length !== 1)
            throw new Error(
              "An item rate profile pin was not saved. Reload the rate book and try again.",
            );
          seenProfiles.add(line.itemId);
        }
        const inserted = await tx.execute(
          sql`
          insert into item_rate_lines (
            org_id, version_id, item_id, unit_code, unit_name, base_quantity,
            cost_rate, bill_rate, time_type_bill_rates, sort_order, created_by, updated_by
          ) values (
            ${gate.user.orgId}, ${version.id}, ${line.itemId}, ${line.unitCode}, ${line.unitName}, ${line.baseQuantity},
            ${line.costRate}, ${line.billRate}, ${JSON.stringify(line.timeTypeBillRates)}::jsonb,
            ${validated.lines.indexOf(line)}, ${gate.user.id}, ${gate.user.id}
          ) returning id`,
          "objects",
        );
        if (inserted.length !== 1)
          throw new Error("A rate line was not saved. Reload the rate book and try again.");
      }
      const activated = await tx.execute(
        sql`
        update item_rate_versions
           set status = 'active', updated_at = now(), updated_by = ${gate.user.id}
         where id = ${version.id} and org_id = ${gate.user.orgId} and status = 'draft'
         returning id`,
        "objects",
      );
      if (activated.length !== 1)
        throw new Error(
          "The new rate version could not be activated. Reload the rate book and try again.",
        );
      const audited = await tx.execute(
        sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (
          ${gate.user.orgId}, 'item_rate_versions', ${version.id}, 'insert',
          ${JSON.stringify({
            rateBookId: bookId,
            effectiveFrom,
            effectiveTo,
            lineCount: validated.lines.length,
            closedVersion,
            ...(laborPolicy ? { laborPolicy: { before: null, after: laborPolicy } } : {}),
          })}::jsonb,
          ${gate.user.id}
        ) returning id`,
        "objects",
      );
      if (audited.length !== 1)
        throw new Error(
          "The rate version audit was not saved. Reload the rate book and try again.",
        );
      return { id: bookId, versionId: version.id };
    });
    return NextResponse.json(result);
  } catch (error) {
    const codeValue = databaseCode(error);
    if (codeValue === "23505") {
      return NextResponse.json(
        {
          error: "That rate-book code or effective date is already in use. Choose a unique value.",
        },
        { status: 409 },
      );
    }
    if (codeValue === "23P01") {
      return NextResponse.json(
        {
          error:
            "That effective date overlaps an active rate version. Choose a date after the current version.",
        },
        { status: 409 },
      );
    }
    const message = error instanceof Error ? error.message : "The rate book could not be saved.";
    const status = message === "not found" ? 404 : 422;
    return NextResponse.json(
      {
        error:
          message === "default-required"
            ? "The default rate book must remain active and default. Make another active book the default first."
            : message,
      },
      { status },
    );
  }
}

export async function loadRateBookDrawerData(
  orgId: string,
  bookId: string | null,
  currencyFallback = "USD",
) {
  const [versions, items, org] = await Promise.all([
    bookId
      ? db.execute<{
          id: string;
          effective_from: string;
          effective_to: string | null;
          labor_derivation_policy: "explicit" | "time_type_multipliers" | null;
        }>(
          sql`
          select v.id, v.effective_from, v.effective_to, p.derivation_policy as labor_derivation_policy
            from item_rate_versions v
            left join labor_rate_version_policies p on p.org_id = v.org_id and p.version_id = v.id
           where v.org_id = ${orgId} and v.rate_book_id = ${bookId} and v.status = 'active'
           order by v.effective_from desc
           limit 1`,
          "objects",
        )
      : Promise.resolve([]),
    db.execute<{
      id: string;
      code: string | null;
      name: string;
      kind: string;
      unit: string | null;
      is_active: boolean;
    }>(
      sql`
        select id, code, name, kind, unit, is_active
          from items
         where org_id = ${orgId}
         order by is_active desc, name, code`,
      "objects",
    ),
    db.execute<{ base_currency: string }>(
      sql`select base_currency from orgs where id = ${orgId}`,
      "objects",
    ),
  ]);
  const version = versions[0];
  const lines = version
    ? await db.execute<{
        item_id: string;
        unit_code: string;
        unit_name: string;
        base_quantity: string;
        cost_rate: string | null;
        bill_rate: string | null;
        time_type_bill_rates: Record<string, string> | null;
        base_unit: string | null;
        pricing_policy: string | null;
        invoice_presentation: string | null;
      }>(
        sql`
          select line.item_id, line.unit_code, line.unit_name, line.base_quantity,
                 line.cost_rate, line.bill_rate, line.time_type_bill_rates,
                 coalesce(pin.base_unit, profile.base_unit) as base_unit,
                 coalesce(pin.pricing_policy, profile.pricing_policy) as pricing_policy,
                 coalesce(pin.invoice_presentation, profile.invoice_presentation) as invoice_presentation
            from item_rate_lines line
            left join item_rate_version_profiles pin
              on pin.org_id = line.org_id and pin.version_id = line.version_id and pin.item_id = line.item_id
            left join item_rate_profiles profile
              on profile.org_id = line.org_id and profile.item_id = line.item_id
           where line.org_id = ${orgId} and line.version_id = ${version.id}
           order by line.sort_order, line.item_id, line.unit_code`,
        "objects",
      )
    : [];
  return {
    latestEffectiveFrom: version?.effective_from
      ? String(version.effective_from).slice(0, 10)
      : null,
    latestEffectiveTo: version?.effective_to ? String(version.effective_to).slice(0, 10) : null,
    latestLaborDerivationPolicy: version?.labor_derivation_policy ?? null,
    lines: lines.map((line) => ({
      itemId: String(line.item_id),
      unitCode: String(line.unit_code),
      unitName: String(line.unit_name),
      baseQuantity: String(line.base_quantity),
      costRate: line.cost_rate == null ? "" : String(line.cost_rate),
      billRate: line.bill_rate == null ? "" : String(line.bill_rate),
      baseUnit: line.base_unit ? String(line.base_unit) : String(line.unit_code),
      pricingPolicy: line.pricing_policy ? String(line.pricing_policy) : "capped_ladder",
      invoicePresentation: line.invoice_presentation
        ? String(line.invoice_presentation)
        : "rate_components",
      timeTypeBillRates: line.time_type_bill_rates ?? {},
    })),
    items: items.map((item) => ({
      id: String(item.id),
      code: item.code,
      name: item.name,
      kind: item.kind,
      unit: item.unit,
      isActive: item.is_active,
    })),
    baseCurrency: String(org[0]?.base_currency ?? currencyFallback),
  };
}

export async function getItemRateBookVersion(orgId: string, bookId: string) {
  const book = await db.execute<{ currency: string }>(
    sql`select currency from item_rate_books where org_id = ${orgId} and id = ${bookId}`,
    "objects",
  );
  if (!book[0]) return null;
  return loadRateBookDrawerData(orgId, bookId, book[0].currency);
}
