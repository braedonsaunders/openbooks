import { formatMoney, sum, toUnits } from "../money/money.ts";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { unsealJson } from "../platform/secrets.ts";
import { PaymentError } from "./payment-errors.ts";
import { isValidBic, isValidIban } from "./rail-settings.ts";

export interface SepaSettings {
  originatorName: string;
  originatorIban: string;
  originatorBic: string;
}

export function validateSepaSettings(raw: Partial<SepaSettings> | null): { ok: true; settings: SepaSettings } | { ok: false; missing: string[] } {
  const s = raw ?? {};
  const missing = (["originatorName", "originatorIban", "originatorBic"] as (keyof SepaSettings)[]).filter(
    (k) => typeof s[k] !== "string" || (s[k] as string).trim() === "" || (s[k] as string).includes("FILL-ME"),
  );
  if (typeof s.originatorIban === "string" && !isValidIban(s.originatorIban)) {
    missing.push("originatorIban");
  }
  if (typeof s.originatorBic === "string" && !isValidBic(s.originatorBic)) {
    missing.push("originatorBic");
  }
  if (missing.length) return { ok: false, missing: [...new Set(missing)] };
  return {
    ok: true,
    settings: {
      originatorName: s.originatorName!.trim(),
      originatorIban: s.originatorIban!.replace(/\s/g, "").toUpperCase(),
      originatorBic: s.originatorBic!.trim().toUpperCase(),
    },
  };
}

export async function loadSepaSettings(orgId: string, runId?: string) {
  const r = (await db.execute<{ originator_secrets_encrypted: string | null }>(sql`
    select p.originator_secrets_encrypted
      from payment_bank_profiles p
      join payment_formats f on f.id = p.payment_format_id and f.org_id = p.org_id
      left join payment_runs r on r.payment_bank_profile_id = p.id and r.org_id = p.org_id
     where p.org_id = ${orgId} and p.is_active and f.rail in ('sepa_credit', 'sepa_debit')
       and (${runId ?? null}::uuid is null or r.id = ${runId ?? null})
     order by case when r.id is not null then 0 else 1 end, p.created_at
     limit 1
  `));
  return validateSepaSettings(unsealJson<Partial<SepaSettings>>(r.rows[0]?.originator_secrets_encrypted));
}

const xmlEsc = (v: string) => v.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]!));

/** Build a SEPA pain.001.001.03 Customer Credit Transfer Initiation (EUR). */
export function buildSepaFile(opts: {
  settings: SepaSettings;
  messageId: string;
  creationDateTime: string; // ISO
  executionDate: string; // YYYY-MM-DD
  payments: { endToEndId: string; amount: string; creditorName: string; creditorIban: string; creditorBic?: string | null; remittance: string | null }[];
}): string {
  const settings = validateSepaSettings(opts.settings);
  if (!settings.ok) {
    throw new PaymentError(`SEPA originator settings are invalid: ${settings.missing.join(", ")}`);
  }
  const s = settings.settings;
  if (opts.payments.length === 0) throw new PaymentError("run has no payments to export");
  // pain.001 carries exact 2dp credit amounts: a non-positive payment is not
  // a credit transfer, and anything finer than cents must fail here rather
  // than be silently rounded into CtrlSum and InstdAmt (the CPA-005, NACHA,
  // and SEPA-debit writers all refuse non-positive amounts the same way).
  for (const payment of opts.payments) {
    const units = toUnits(payment.amount);
    if (units <= 0n) throw new PaymentError("payment amounts must be positive");
    if (units % 100n !== 0n) {
      throw new PaymentError(`payment amount ${payment.amount} has sub-cent precision`);
    }
    if (!isValidIban(payment.creditorIban)) {
      throw new PaymentError(`creditor IBAN for ${payment.creditorName} is invalid`);
    }
    const creditorBic = (payment.creditorBic ?? "").trim();
    if (creditorBic && !isValidBic(creditorBic)) {
      throw new PaymentError(`creditor BIC for ${payment.creditorName} is invalid`);
    }
  }
  const ctrlSum = formatMoney(sum(opts.payments.map((payment) => payment.amount)), 2);
  const nb = opts.payments.length;
  const tx = opts.payments.map((p) => {
    const bic = (p.creditorBic ?? "").trim().toUpperCase();
    const iban = p.creditorIban.replace(/\s/g, "").toUpperCase();
    return `      <CdtTrfTxInf>
        <PmtId><EndToEndId>${xmlEsc(p.endToEndId.slice(0, 35))}</EndToEndId></PmtId>
        <Amt><InstdAmt Ccy="EUR">${formatMoney(p.amount, 2)}</InstdAmt></Amt>
${bic ? `        <CdtrAgt><FinInstnId><BIC>${xmlEsc(bic)}</BIC></FinInstnId></CdtrAgt>\n` : ""}        <Cdtr><Nm>${xmlEsc(p.creditorName.slice(0, 70))}</Nm></Cdtr>
        <CdtrAcct><Id><IBAN>${xmlEsc(iban)}</IBAN></Id></CdtrAcct>
        <RmtInf><Ustrd>${xmlEsc((p.remittance ?? p.endToEndId).slice(0, 140))}</Ustrd></RmtInf>
      </CdtTrfTxInf>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${xmlEsc(opts.messageId.slice(0, 35))}</MsgId>
      <CreDtTm>${opts.creationDateTime}</CreDtTm>
      <NbOfTxs>${nb}</NbOfTxs>
      <CtrlSum>${ctrlSum}</CtrlSum>
      <InitgPty><Nm>${xmlEsc(s.originatorName.slice(0, 70))}</Nm></InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${xmlEsc(opts.messageId.slice(0, 35))}</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <NbOfTxs>${nb}</NbOfTxs>
      <CtrlSum>${ctrlSum}</CtrlSum>
      <PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl></PmtTpInf>
      <ReqdExctnDt>${opts.executionDate}</ReqdExctnDt>
      <Dbtr><Nm>${xmlEsc(s.originatorName.slice(0, 70))}</Nm></Dbtr>
      <DbtrAcct><Id><IBAN>${xmlEsc(s.originatorIban.replace(/\s/g, ""))}</IBAN></Id></DbtrAcct>
      <DbtrAgt><FinInstnId><BIC>${xmlEsc(s.originatorBic)}</BIC></FinInstnId></DbtrAgt>
      <ChrgBr>SLEV</ChrgBr>
${tx}
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>
`;
}
