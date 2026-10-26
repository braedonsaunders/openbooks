import { z } from "zod";
import { defineRoute } from "@/lib/api/route";

import { NextResponse } from "next/server";
import { computeNextRunAt, type BackupPolicyShape } from "@openbooks/engine/backup/backup";
import { saveBackupPolicy, type BackupPolicyValues } from "@openbooks/engine/backup/policy";

const requestBodySchema = z.discriminatedUnion("frequency", [
  z.object({
    frequency: z.literal("daily"),
    enabled: z.boolean(),
    hourUtc: z.number().int().min(0).max(23),
    dayOfWeek: z.number().int().min(0).max(6),
    dayOfMonth: z.number().int().min(1).max(28),
    maxKeep: z.number().int().min(1).max(100),
  }),
  z.object({
    frequency: z.literal("weekly"),
    enabled: z.boolean(),
    hourUtc: z.number().int().min(0).max(23),
    dayOfWeek: z.number().int().min(0).max(6),
    dayOfMonth: z.number().int().min(1).max(28),
    maxKeep: z.number().int().min(1).max(100),
  }),
  z.object({
    frequency: z.literal("monthly"),
    enabled: z.boolean(),
    hourUtc: z.number().int().min(0).max(23),
    dayOfWeek: z.number().int().min(0).max(6),
    dayOfMonth: z.number().int().min(1).max(28),
    maxKeep: z.number().int().min(1).max(100),
  }),
]);

export const runtime = "nodejs";

/**
 * Scheduled-backup policy for the org (one row per org, keyed by org_id).
 * Upserting recomputes next_run_at from the new cadence; disabling clears it.
 * Every change is audited with before/after tuples.
 */

const FREQUENCIES = new Set(["daily", "weekly", "monthly"]);

export const PUT = defineRoute({
  permission: "admin.backups.manage",
  feature: {
    none: "Backup retention policy is organization-wide setup governed by backup management permission.",
  },
  scope: "unrestricted",
  body: requestBodySchema,
  handler: async ({ body, authz: routeAuthz }) => {
    const gate = routeAuthz;

    const actor = gate.user;
    const { orgId } = actor;

    const enabled = body.enabled;
    if (typeof enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
    }
    const frequency = body.frequency;
    if (typeof frequency !== "string" || !FREQUENCIES.has(frequency)) {
      return NextResponse.json(
        { error: "frequency must be daily, weekly, or monthly" },
        { status: 400 },
      );
    }
    const intIn = (v: unknown, min: number, max: number): number | null => {
      const n = Number(v);
      return Number.isInteger(n) && n >= min && n <= max ? n : null;
    };
    const hourUtc = intIn(body.hourUtc, 0, 23);
    if (hourUtc === null) {
      return NextResponse.json({ error: "hourUtc must be an integer 0–23" }, { status: 400 });
    }
    const dayOfWeek = intIn(body.dayOfWeek, 0, 6);
    if (dayOfWeek === null) {
      return NextResponse.json({ error: "dayOfWeek must be an integer 0–6" }, { status: 400 });
    }
    const dayOfMonth = intIn(body.dayOfMonth, 1, 28);
    if (dayOfMonth === null) {
      return NextResponse.json({ error: "dayOfMonth must be an integer 1–28" }, { status: 400 });
    }
    const maxKeep = intIn(body.maxKeep, 1, 100);
    if (maxKeep === null) {
      return NextResponse.json({ error: "maxKeep must be an integer 1–100" }, { status: 400 });
    }

    const shape = {
      frequency: frequency as BackupPolicyShape["frequency"],
      hourUtc,
      dayOfWeek,
      dayOfMonth,
    } satisfies BackupPolicyShape;
    const nextRunAt = enabled ? computeNextRunAt(shape, new Date()).toISOString() : null;
    await saveBackupPolicy(orgId, actor.id, { ...shape, enabled, maxKeep }, nextRunAt);

    return NextResponse.json({ ok: true, nextRunAt });
  },
});
