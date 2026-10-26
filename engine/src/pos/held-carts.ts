import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { posRefusal } from "./errors.ts";
import { loadRegisterForUse } from "./registers.ts";
import { assertRegisterFeature } from "./sessions.ts";

/**
 * Carts parked at a register. A held cart is working state, not a
 * transaction: it records only what was rung up (items, quantities,
 * discounts, customer) so the cashier can serve the next customer and
 * resume it later. Resuming removes it; nothing is priced or posted until
 * the resumed cart is completed as a sale.
 */

export interface HeldCartContent {
  customerId: string | null;
  lines: Array<{ itemId: string; quantity: string; unitPrice?: string | null; discount?: unknown }>;
  orderDiscount?: unknown;
}

function validateContent(raw: unknown): HeldCartContent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw posRefusal(
      "The held cart is not a cart.",
      "invalid_input",
      422,
      "Hold the cart again from the register.",
    );
  }
  const cart = raw as Record<string, unknown>;
  const lines = Array.isArray(cart.lines) ? cart.lines : [];
  if (lines.length === 0 || lines.length > 200) {
    throw posRefusal(
      "A held cart needs between one and 200 lines.",
      "invalid_input",
      422,
      "Add items before holding the cart.",
    );
  }
  for (const line of lines) {
    if (
      !line ||
      typeof line !== "object" ||
      !isUuid((line as Record<string, unknown>).itemId as string)
    ) {
      throw posRefusal(
        "A held cart line names no item.",
        "invalid_input",
        422,
        "Hold the cart again from the register.",
      );
    }
  }
  const customerId =
    typeof cart.customerId === "string" && isUuid(cart.customerId) ? cart.customerId : null;
  return {
    customerId,
    lines: lines as HeldCartContent["lines"],
    orderDiscount: cart.orderDiscount ?? null,
  };
}

export async function holdCart(input: {
  orgId: string;
  actorId: string;
  registerId: string;
  label: string;
  cart: unknown;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<{ id: string }> {
  const label = input.label.trim();
  if (label.length === 0 || label.length > 120) {
    throw posRefusal(
      "Name the held cart in 1 to 120 characters.",
      "invalid_input",
      422,
      "Enter a short name, such as the customer's name.",
    );
  }
  const content = validateContent(input.cart);
  return withOrgTransaction(input.orgId, async () => {
    await assertRegisterFeature(db, input.orgId);
    const register = await loadRegisterForUse(db, input.orgId, input.registerId, {
      allowedSubsidiaryIds: input.allowedSubsidiaryIds,
    });
    const rows = await db.execute<{ id: string }>(
      sql`
      insert into pos_held_carts (org_id, register_id, label, cart, created_by, updated_by)
      values (${input.orgId}, ${register.id}, ${label}, ${JSON.stringify(content)}::jsonb, ${input.actorId}, ${input.actorId})
      returning id`,
      "objects",
    );
    if (rows.length !== 1) throw new Error("held cart insert returned an unexpected row count");
    return { id: rows[0]!.id };
  });
}

export async function listHeldCarts(
  orgId: string,
  registerId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<
  Array<{ id: string; label: string; lineCount: number; heldAt: string; heldBy: string | null }>
> {
  return withOrgTransaction(orgId, async () => {
    const register = await loadRegisterForUse(db, orgId, registerId, { allowedSubsidiaryIds });
    return await db.execute<{
      id: string;
      label: string;
      lineCount: number;
      heldAt: string;
      heldBy: string | null;
    }>(
      sql`
      select h.id, h.label, jsonb_array_length(h.cart->'lines')::int as "lineCount", h.created_at::text as "heldAt", u.name as "heldBy"
        from pos_held_carts h
        left join users u on u.org_id = h.org_id and u.id = h.created_by
       where h.org_id = ${orgId} and h.register_id = ${register.id}
       order by h.created_at`,
      "objects",
    );
  });
}

export interface ResumedCart extends HeldCartContent {
  customerName: string | null;
  items: Record<string, { name: string; code: string | null }>;
}

/** Resume a held cart: returns its content with current item and customer names, and removes it, exactly once. */
export async function resumeHeldCart(
  orgId: string,
  registerId: string,
  heldCartId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<ResumedCart> {
  if (!isUuid(heldCartId)) {
    throw posRefusal(
      "That held cart does not exist.",
      "held_cart_not_found",
      404,
      "Reload the held carts.",
    );
  }
  return withOrgTransaction(orgId, async () => {
    await assertRegisterFeature(db, orgId);
    const register = await loadRegisterForUse(db, orgId, registerId, { allowedSubsidiaryIds });
    const rows = await db.execute<{ cart: HeldCartContent }>(
      sql`
      delete from pos_held_carts where org_id = ${orgId} and register_id = ${register.id} and id = ${heldCartId}
      returning cart`,
      "objects",
    );
    if (rows.length !== 1) {
      throw posRefusal(
        "That held cart was already resumed or does not exist.",
        "held_cart_not_found",
        404,
        "Reload the held carts.",
      );
    }
    const cart = rows[0]!.cart;
    const itemIds = [...new Set(cart.lines.map((line) => line.itemId).filter((id) => isUuid(id)))];
    const items =
      itemIds.length === 0
        ? []
        : await db.execute<{ id: string; name: string; code: string | null }>(
            sql`
      select id, name, code from items where org_id = ${orgId} and id in (${sql.join(
        itemIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
            "objects",
          );
    const customerName = cart.customerId
      ? ((
          await db.execute<{ name: string }>(
            sql`
          select display_name as name from parties where org_id = ${orgId} and id = ${cart.customerId}`,
            "objects",
          )
        )[0]?.name ?? null)
      : null;
    return {
      ...cart,
      customerName,
      items: Object.fromEntries(
        items.map((item) => [item.id, { name: item.name, code: item.code }]),
      ),
    };
  });
}
