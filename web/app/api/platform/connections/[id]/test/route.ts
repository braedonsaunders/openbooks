import { NextResponse } from "next/server";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import {
  loadConnectionProbeRow,
  writeConnectionProbeOutcome,
} from "@openbooks/engine/sync/connection-admin";
import { buildSource } from "@openbooks/engine/sync/connection";
import { storageIdentityError } from "../../_storage-identity";
import { connectionConfigUrlRefusal } from "../../_connector-guard";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Test a connection's credentials and persist the probe outcome onto that
 * same version of the row (status / last_error). Probe target and version
 * token come from one read; a concurrent change leaves the new row untouched.
 */
export const POST = defineRoute({
  permission: "sync.run",
  feature: {
    none: "Connection probes are controlled by sync-run permission and have no separate organization feature gate.",
  },
  scope: "unrestricted",
  params: z.object({ id: z.string() }),
  handler: async ({ params: { id }, authz: gate }) => {
    // Probing a connection exercises its credentials the way a run does, so
    // it rides the `sync.run` grant beside the run route; reconfiguring the
    // connection itself stays `admin.setup.manage`.
    const row = await loadConnectionProbeRow(gate.user.orgId, id).catch((e) => {
      if (storageIdentityError(e)) return null;
      throw e;
    });
    if (!row) return notFound("record");
    const urlError = await connectionConfigUrlRefusal(row.config);
    if (urlError) {
      // A refused connector URL is a validation refusal on a found connection
      // (fix the connector URL and retry), never a missing connection.
      return NextResponse.json(
        { error: urlError, errorCode: "CONNECTOR_URL_REFUSED" },
        { status: 422 },
      );
    }

    const stale = () =>
      NextResponse.json(
        {
          error: "connection changed during the test; retry against the current configuration",
          errorCode: "CONNECTION_CHANGED",
        },
        { status: 409 },
      );

    try {
      const source = buildSource(row);
      if (source.ping) {
        const r = await source.ping();
        const status = r.ok ? "active" : "error";
        const lastError = r.ok ? null : (r.detail ?? "connection ping failed");
        const matched = await writeConnectionProbeOutcome(
          gate.user.orgId,
          id,
          row,
          status,
          lastError,
        );
        if (!matched) return stale();
        return NextResponse.json({ ok: r.ok, detail: r.detail }, { status: r.ok ? 200 : 422 });
      }
      const tb = await source.trialBalance();
      const matched = await writeConnectionProbeOutcome(gate.user.orgId, id, row, "active", null);
      if (!matched) return stale();
      return NextResponse.json({
        ok: true,
        detail: `${tb.length} accounts in trial balance`,
      });
    } catch (e) {
      const message = (e as Error).message;
      const matched = await writeConnectionProbeOutcome(gate.user.orgId, id, row, "error", message);
      if (!matched) return stale();
      return NextResponse.json({ ok: false, error: message }, { status: 422 });
    }
  },
});
