import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { businessToday } from "@openbooks/engine/src/business-date.ts";
import { cmp, formatMoney, isZero, normalizeMoney, sum } from "@openbooks/engine/src/money.ts";
import { canonicalDecimal } from "../exact-decimal";
import type { AssistantToolDef, ToolResult } from "./types";
import { signProposal, type JournalLinePreview, type JournalPreview } from "./proposals";

/**
 * Draft (write) tools use the propose→confirm→commit pattern. The tool never writes:
 * it validates, resolves accounts, and returns an HMAC-signed proposal the UI
 * renders as a confirmation card. Only the user's Apply click (the
 * /api/assistant/commit route) creates anything — and even then it creates a
 * DRAFT journal document the user posts from /journal, so the assistant can
 * never touch the posted ledger.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const journalDraftSchema = z.object({
  documentDate: z.string().regex(ISO_DATE, "YYYY-MM-DD").optional()
    .describe("Defaults to today"),
  memo: z.string().max(500).optional(),
  lines: z
    .array(
      z.object({
        account: z.string().max(120)
          .describe("Account number (preferred, e.g. '5100') or exact account name"),
        description: z.string().max(200).optional(),
        amount: z.number()
          .describe("Signed base amount: positive = debit, negative = credit"),
      }),
    )
    .min(2)
    .max(30),
});

const draftJournalEntry: AssistantToolDef = {
  name: "draft_journal_entry",
  description:
    "Draft (do NOT create) a balanced manual journal entry for the user to review and confirm. Lines must sum to zero (debits positive, credits negative). You cannot create it directly — the user must click Apply, which saves it as a DRAFT journal they still post themselves. Never say you recorded it; say you drafted it.",
  category: "write",
  requiresConfirmation: true,
  gate: { mode: "anyOf", perms: ["gl.post"] },
  inputSchema: journalDraftSchema,
  execute: async (raw, authz): Promise<ToolResult> => {
    const parsed = journalDraftSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "invalid_input" };
    const a = parsed.data;

    // Reject imbalance up front with a message the model can act on.
    let exactAmounts: string[];
    try {
      exactAmounts = a.lines.map((line) => {
        const exact = canonicalDecimal(line.amount, 4);
        if (exact === null) throw new Error("invalid_amount");
        return normalizeMoney(exact);
      });
    } catch {
      return { ok: false, error: "line amounts must have at most four decimal places" };
    }
    const total = sum(exactAmounts);
    if (!isZero(total)) {
      return {
        ok: false,
        error: `lines must balance to zero; they sum to ${formatMoney(total, 2)}`,
      };
    }

    // Resolve each line's account by number first, then exact name — against
    // active, postable (non-summary) accounts only.
    const lines: JournalLinePreview[] = [];
    for (let index = 0; index < a.lines.length; index++) {
      const l = a.lines[index]!;
      const key = l.account.trim();
      const r = (await db.execute<{ id: string; number: string | null; name: string }>(sql`
        select id, number, name from accounts
         where org_id = ${authz.user.orgId} and is_active and not is_summary
           and (number = ${key} or lower(name) = lower(${key}))
         order by (number = ${key}) desc
         limit 2
      `));
      if (r.rows.length === 0) {
        return { ok: false, error: `account not found: "${key}" — use find_accounts to locate it` };
      }
      if (r.rows.length > 1 && r.rows[0]!.number !== key) {
        return { ok: false, error: `account "${key}" is ambiguous — pass its number instead` };
      }
      const acct = r.rows[0]!;
      lines.push({
        accountId: acct.id,
        accountLabel: `${acct.number ?? ""} · ${acct.name}`.replace(/^ · /, ""),
        description: l.description?.trim() || null,
        // exactAmounts is already canonical numeric(19,4) money. Keep the
        // signed proposal value intact so confirmation reviews and commits do
        // not silently round valid four-decimal input to cents.
        amount: exactAmounts[index]!,
      });
    }

    const preview: JournalPreview = {
      documentDate: a.documentDate ?? (await businessToday(authz.user.orgId)),
      memo: a.memo?.trim() || null,
      lines,
    };
    const confirmToken = signProposal("create_journal_entry", preview, authz);
    return {
      ok: true,
      data: {
        proposed: { kind: "create_journal_entry", preview, confirmToken },
        totalDebits: sum(lines.map((l) => (cmp(l.amount, "0") > 0 ? l.amount : "0"))),
      },
      note: "Drafted for the user to review — nothing is created until they click Apply, and applying only saves a draft journal.",
    };
  },
};

export const WRITE_TOOLS: AssistantToolDef[] = [draftJournalEntry];
