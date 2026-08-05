import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { toUnits } from "./money.ts";
import {
  buildCpa005File,
  buildNachaFile,
  type Cpa005Payment,
  decryptAccountNumber,
  loadEftSettings,
  loadNachaSettings,
  type NachaEntry,
} from "./payments.ts";
import { assertNotSandbox } from "./sandbox/guard.ts";
import { PayrollError } from "./payroll-run.ts";

/**
 * Pay-run bank file — direct deposit for a committed run, one payment per
 * stub from the employee's approved bank account.
 *
 * The file format is a dispatch argument riding the payments machinery
 * (CPA-005 today, NACHA for US banking), NOT a country-pack concern: the
 * format is a property of the org's bank, not of the tax jurisdiction, and
 * the payments module already owns originator settings and file writers.
 * Packs stay purely statutory.
 *
 * Fails closed: any employee without an approved, complete bank account (or
 * with sub-cent net pay) blocks the whole file, with every problem named —
 * no partial or fake files, matching the AP EFT/ACH exports.
 */

export type PayRunBankFileFormat = "cpa005" | "nacha";

interface StubPayment {
  employeePartyId: string;
  employeeName: string;
  netCents: bigint;
  routing: Record<string, string>;
  accountNumber: string;
}

export async function buildPayRunBankFile(opts: {
  orgId: string;
  documentId: string;
  format?: PayRunBankFileFormat;
}): Promise<{ filename: string; content: string; contentType: string }> {
  const { orgId, documentId } = opts;
  const format: PayRunBankFileFormat = opts.format ?? "cpa005";
  await assertNotSandbox(orgId, "generate payroll bank file");

  const runs = (await db.execute(sql`
    select r.run_status, r.pay_date, d.document_number
      from pay_runs r join documents d on d.id = r.document_id
     where r.org_id = ${orgId} and r.document_id = ${documentId}
  `)) as unknown as { rows: { run_status: string; pay_date: string; document_number: string }[] };
  const run = runs.rows[0];
  if (!run) throw new PayrollError("pay run not found");
  if (run.run_status !== "committed") {
    throw new PayrollError("commit the pay run before generating its bank file");
  }

  const stubs = (await db.execute(sql`
    select s.employee_party_id, s.net_pay, p.display_name,
           b.routing, b.account_number_encrypted, b.account_last_four
      from pay_stubs s
      join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
      left join lateral (
        select routing, account_number_encrypted, account_last_four
          from party_bank_accounts b
         where b.org_id = s.org_id and b.party_id = s.employee_party_id
           and b.is_active and b.approval_status = 'approved'
           and b.retired_at is null
         order by b.created_at desc
         limit 1
      ) b on true
     where s.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
     order by p.display_name
  `)) as unknown as { rows: {
    employee_party_id: string;
    net_pay: string;
    display_name: string;
    routing: Record<string, string> | null;
    account_number_encrypted: string | null;
    account_last_four: string | null;
  }[] };
  if (stubs.rows.length === 0) throw new PayrollError("pay run has no stubs");

  const problems: string[] = [];
  const payments: StubPayment[] = [];
  for (const stub of stubs.rows) {
    const units = toUnits(stub.net_pay);
    if (units <= 0n) continue; // nothing owed — no deposit line
    if (units % 100n !== 0n) {
      problems.push(`${stub.display_name}: net pay has sub-cent precision (${stub.net_pay})`);
      continue;
    }
    if (!stub.routing || !stub.account_number_encrypted) {
      problems.push(`${stub.display_name}: no approved bank account on file`);
      continue;
    }
    if (format === "cpa005") {
      if (!/^\d{3}$/.test(stub.routing.institution ?? "") || !/^\d{5}$/.test(stub.routing.transit ?? "")) {
        problems.push(`${stub.display_name}: EFT needs a 3-digit institution and 5-digit transit`);
        continue;
      }
    } else {
      const aba = stub.routing.aba ?? stub.routing.routingNumber ?? stub.routing.routing ?? "";
      if (!/^\d{9}$/.test(aba)) {
        problems.push(`${stub.display_name}: US ACH needs a 9-digit routing number`);
        continue;
      }
    }
    payments.push({
      employeePartyId: stub.employee_party_id,
      employeeName: stub.display_name,
      netCents: units / 100n,
      routing: stub.routing,
      accountNumber: decryptAccountNumber(stub.account_number_encrypted),
    });
  }
  if (problems.length > 0) {
    throw new PayrollError(`cannot generate the bank file: ${problems.join("; ")}`);
  }
  if (payments.length === 0) throw new PayrollError("no stubs with positive net pay to deposit");

  const fundsDate = new Date(`${run.pay_date}T00:00:00`);

  if (format === "nacha") {
    const settings = await loadNachaSettings(orgId);
    if (!settings.ok) {
      throw new PayrollError(
        `ACH origination is not configured on the payment bank profile: ${settings.missing.join(", ")}`,
      );
    }
    const entries: NachaEntry[] = payments.map((p) => ({
      transactionCode: p.routing.accountType === "savings" ? "32" : "22",
      routingNumber: p.routing.aba ?? p.routing.routingNumber ?? p.routing.routing ?? "",
      accountNumber: p.accountNumber,
      amountCents: p.netCents,
      individualId: run.document_number.slice(0, 15),
      individualName: p.employeeName,
    }));
    const content = buildNachaFile({
      settings: { ...settings.settings, entryClassCode: "PPD", entryDescription: "PAYROLL" },
      effectiveDate: fundsDate,
      creationDate: new Date(),
      entries,
    });
    return {
      filename: `NACHA-${run.document_number}.ach`,
      content,
      contentType: "text/plain; charset=us-ascii",
    };
  }

  const eft = await loadEftSettings(orgId);
  if (!eft.ok) {
    throw new PayrollError(
      `EFT origination is not configured on the payment bank profile: ${eft.missing.join(", ")}`,
    );
  }
  const cpaPayments: Cpa005Payment[] = payments.map((p) => ({
    amountCents: p.netCents,
    fundsDate,
    institution: p.routing.institution!,
    transit: p.routing.transit!,
    accountNumber: p.accountNumber,
    payeeName: p.employeeName,
    crossReference: run.document_number.slice(0, 19),
  }));
  // Derived from the run number so re-downloading reproduces the same file.
  const numeric = run.document_number.replace(/\D/g, "");
  const fileCreationNumber = ((Number(numeric || "1") - 1) % 9999) + 1;
  const content = buildCpa005File({
    settings: eft.settings,
    fileCreationNumber,
    fileCreationDate: new Date(),
    payments: cpaPayments,
  });
  return {
    filename: `CPA005-${run.document_number}.txt`,
    content,
    contentType: "text/plain; charset=us-ascii",
  };
}
