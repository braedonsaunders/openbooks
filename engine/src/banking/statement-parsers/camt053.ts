/** camt.053 statement parsing. Split from banking.ts (ARCH-FILE-SPLIT; pure moves only). */
import { BankingError, type ParsedStatementLine, type ParsedStatement, type StatementSourceContent } from "../banking-core"
import { decodeStatementSourceText } from "../statement-encoding"
import { decodeOfxEntities, assertRealDate, normalizeAmount } from "./shared"


// ---------------------------------------------------------------------------
// International statement formats: CAMT.053 (ISO 20022), BAI2, MT940
// ---------------------------------------------------------------------------

function xmlTag(block: string, tag: string): string | undefined {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? decodeOfxEntities(m[1]!.trim()) : undefined;
}
function xmlTags(block: string, tag: string): string[] {
  return [...block.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi"))].map((m) => m[1]!);
}

/**
 * Parse an ISO 20022 CAMT.053 (Bank-to-Customer Statement) into normalized
 * lines. Reads `<Ntry>` entries — `<Amt Ccy>`, `<CdtDbtInd>` (CRDT/DBIT),
 * booking date, and `<AddtlNtryInf>`/reference text — plus the closing booked
 * balance (`<Bal>` with type code CLBD). Amounts sign from the CdtDbtInd.
 */
export function parseCamt053(source: StatementSourceContent): ParsedStatement {
  const text = decodeStatementSourceText(source, "camt053");
  const stmt = xmlTag(text, "Stmt") ?? text;
  const currency = xmlTag(stmt, "Ccy");
  const lines: ParsedStatementLine[] = [];
  let lineNo = 0;
  for (const ntry of xmlTags(stmt, "Ntry")) {
    const amtRaw = xmlTag(ntry, "Amt");
    if (!amtRaw) continue;
    const ind = (xmlTag(ntry, "CdtDbtInd") ?? "CRDT").toUpperCase();
    const signed = normalizeAmount((ind === "DBIT" ? "-" : "") + amtRaw, "CAMT.053 amount");
    const bookg = xmlTag(ntry, "BookgDt");
    const dt = bookg ? (xmlTag(bookg, "Dt") ?? xmlTag(bookg, "DtTm")) : undefined;
    const iso = dt?.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!iso) throw new BankingError(`CAMT.053: entry missing a booking date`);
    const txDtls = xmlTag(ntry, "TxDtls") ?? ntry;
    const description =
      xmlTag(ntry, "AddtlNtryInf") ??
      xmlTag(txDtls, "AddtlTxInf") ??
      xmlTag(txDtls, "Ustrd") ??
      xmlTag(txDtls, "Nm") ??
      null;
    const ref =
      xmlTag(txDtls, "EndToEndId") ?? xmlTag(txDtls, "TxId") ?? xmlTag(txDtls, "AcctSvcrRef") ?? null;
    // Dedupe identity must be the bank's per-entry reference: the
    // originator-set EndToEndId is reused on every execution of a standing
    // order or recurring collection, so keying by it silently drops every
    // execution after the first at import.
    const bankRef =
      xmlTag(txDtls, "AcctSvcrRef") ?? xmlTag(txDtls, "TxId") ?? xmlTag(txDtls, "EndToEndId") ?? null;
    lines.push({
      postedOn: assertRealDate(iso[1]!, iso[2]!, iso[3]!, `CAMT.053 date "${dt}"`),
      amount: signed,
      description,
      counterpartyRef: ref,
      bankTransactionId: bankRef,
    });
    lineNo++;
  }
  if (lineNo === 0) throw new BankingError("CAMT.053: no <Ntry> entries found");
  // Account identity is the statement's <Acct> (<Id><IBAN>, else
  // <Id><Othr><Id>). Distinct identifiers across the statement would merge
  // ledgers while the balance evidence stays singular — refused like the
  // other multi-account shapes.
  const camtAccounts = new Set<string>();
  for (const acct of xmlTags(stmt, "Acct")) {
    const idBlock = xmlTag(acct, "Id") ?? "";
    const iban = xmlTag(idBlock, "IBAN") ?? xmlTag(acct, "IBAN");
    const other = iban ?? xmlTag(xmlTag(idBlock, "Othr") ?? "", "Id");
    if (other) camtAccounts.add(other);
  }
  if (camtAccounts.size > 1) {
    throw new BankingError(
      `CAMT.053 statement contains multiple accounts (${[...camtAccounts].join(", ")}) — import one account per statement so each keeps its own balance and lines`,
    );
  }
  const camtAccountId = [...camtAccounts][0];
  // closing booked balance (CLBD)
  let closingBalance: string | undefined;
  let statementDate: string | undefined;
  for (const bal of xmlTags(stmt, "Bal")) {
    const cd = xmlTag(bal, "Cd");
    if (cd && /CLBD|CLAV/i.test(cd)) {
      const amt = xmlTag(bal, "Amt");
      const ind = (xmlTag(bal, "CdtDbtInd") ?? "CRDT").toUpperCase();
      if (amt) closingBalance = normalizeAmount((ind === "DBIT" ? "-" : "") + amt, "CAMT.053 balance");
      const bd = xmlTag(bal, "Dt");
      const m = bd?.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) statementDate = assertRealDate(m[1]!, m[2]!, m[3]!, "CAMT.053 balance date");
    }
  }
  return { lines, currency, statementDate, closingBalance, externalAccountId: camtAccountId };
}
