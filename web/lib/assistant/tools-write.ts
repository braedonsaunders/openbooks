import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { sum } from "@openbooks/engine/src/money.ts";
import type { AssistantToolDef, ToolResult } from "./types";
import { signProposal, type JournalLinePreview, type JournalPreview } from "./proposals";

/**
 * Draft (write) tools — the propose→confirm→commit pattern ported from
 * beaconhs's draft_incident / draft_corrective_action. The tool NEVER writes:
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
    const total = a.lines.reduce((acc, l) => acc + Math.round(l.amount * 100), 0);
    if (total !== 0) {
      return {
        ok: false,
        error: `lines must balance to zero; they sum to ${(total / 100).toFixed(2)}`,
      };
    }

    // Resolve each line's account by number first, then exact name — against
    // active, postable (non-summary) accounts only.
    const lines: JournalLinePreview[] = [];
    for (const l of a.lines) {
      const key = l.account.trim();
      const r = (await db.execute(sql`
        select id, number, name from accounts
         where is_active and not is_summary
           and (number = ${key} or lower(name) = lower(${key}))
         order by (number = ${key}) desc
         limit 2
      `)) as unknown as { rows: { id: string; number: string | null; name: string }[] };
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
        amount: l.amount.toFixed(2),
      });
    }

    const preview: JournalPreview = {
      documentDate: a.documentDate ?? new Date().toISOString().slice(0, 10),
      memo: a.memo?.trim() || null,
      lines,
    };
    const confirmToken = signProposal("create_journal_entry", preview, authz);
    return {
      ok: true,
      data: {
        proposed: { kind: "create_journal_entry", preview, confirmToken },
        totalDebits: sum(lines.map((l) => (Number(l.amount) > 0 ? l.amount : "0"))),
      },
      note: "Drafted for the user to review — nothing is created until they click Apply, and applying only saves a draft journal.",
    };
  },
};

export const WRITE_TOOLS: AssistantToolDef[] = [draftJournalEntry];
