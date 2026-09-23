import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { parseIsoDate } from "../platform/business-date.ts";
import { unsealJson } from "../platform/secrets.ts";
import { PaymentError } from "./payment-errors.ts";

// ---------------------------------------------------------------------------
// CNAB 240 — Banco do Brasil variant: counterparty coordinates + originator
// ---------------------------------------------------------------------------

/**
 * A Brazilian bank code (código de compensação / ISPB participant): 3 digits.
 *
 * '001' is Banco do Brasil; any other code on this rail means the credit
 * leaves BB as a TED (câmara 018). Shape only: allocation validity is the
 * Banco Central's, not a transcription here.
 */
export function isValidBancoCode(value: string): boolean {
  return /^\d{3}$/.test(value.trim());
}

/**
 * A Brazilian agência number: 1–5 digits, zero-padded to 5 on the wire
 * (CNAB 240 G008). BB agências are 4 digits; other banks vary. Anything
 * longer cannot be expressed in the fixed-width agência field and is
 * refused, never truncated into another branch's number.
 */
export function normalizeAgencia(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  if (!/^\d{1,5}$/.test(digits)) return null;
  if (/^0+$/.test(digits)) return null;
  return digits.padStart(5, "0");
}

/**
 * A Brazilian conta number: 1–12 digits, zero-padded to 12 on the wire
 * (CNAB 240 G010). Longer values are refused, never truncated into a
 * differently-numbered account.
 */
export function normalizeContaNumero(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  if (!/^\d{1,12}$/.test(digits)) return null;
  if (/^0+$/.test(digits)) return null;
  return digits.padStart(12, "0");
}

/**
 * A single agency/account check digit (G009/G011): one alphanumeric
 * character (BB digits are numeric; 'X' occurs). Blank is not a digit —
 * a missing DV is refused rather than zero-filled into a wrong one.
 */
export function isValidContaDv(value: string): boolean {
  return /^[A-Za-z0-9]$/.test(value.trim());
}

/**
 * A CPF (11 digits) or CNPJ (14 digits) with VALID check digits (módulo 11).
 *
 * Unlike the Bacs modulus tables — pinned weight tables that false-refuse
 * newly allocated accounts — the CPF/CNPJ check-digit algorithm is public,
 * stable (Receita Federal, unchanged for decades) and table-free, so a
 * mistyped inscription is refused here rather than emitted into Segmento B,
 * where the bank's confrontation would reject it (or worse, the wrong
 * inscription would ride alongside the right account). All-same-digit
 * values are structurally invalid and refused. Formatting (dots, slash,
 * hyphen, spaces) edits out; anything else is not an inscription.
 */
export function normalizeCpfCnpj(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 11 && digits.length !== 14) return null;
  if (/^(\d)\1+$/.test(digits)) return null;
  const mod11 = (base: string, weights: number[]): number => {
    const sum = base.split("").reduce((acc, d, i) => acc + Number(d) * weights[i]!, 0);
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  };
  if (digits.length === 11) {
    const body = digits.slice(0, 9);
    const d1 = mod11(body, [10, 9, 8, 7, 6, 5, 4, 3, 2]);
    const d2 = mod11(body + String(d1), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
    if (digits !== `${body}${d1}${d2}`) return null;
    return digits;
  }
  const body = digits.slice(0, 12);
  const d1 = mod11(body, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = mod11(body + String(d1), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (digits !== `${body}${d1}${d2}`) return null;
  return digits;
}

export function isValidCpfCnpj(value: string): boolean {
  return normalizeCpfCnpj(value) !== null;
}

/** Segmento B G005: '1' pessoa física (CPF), '2' pessoa jurídica (CNPJ). */
export function inscricaoTipoFor(digits: string): "1" | "2" | null {
  if (digits.length === 11) return "1";
  if (digits.length === 14) return "2";
  return null;
}

// NOTE: CNAB 240 originator settings ARE shaped here (like the Bacs rail)
// because the writer needs exactly the bank-assigned convênio coordinates —
// the 9-digit BB payment convênio, the debit agência/conta with their DVs,
// the employer CNPJ and the company name — and each is validated to its
// channel shape below. The ARQUIVO layout version (164–166) is REQUIRED
// tenant configuration rather than a default: versions are bank- and
// era-specific (Bradesco '089', Inter '107', BB '050'–'084' across manual
// vintages) and must match the lote version per the bank's pairing table,
// so inventing one risks a file the bank's parser rejects. The LOTE version
// is pinned to '045' — the current version in all three BB-flavored
// transcriptions. The file LAYOUT they populate is transcribed in
// `buildCnab240BbFile` (engine/src/payments/rail-cnab240-bb.ts) with
// per-field source notes.
export interface Cnab240BbSettings {
  /** Employer CNPJ, 14 digits (header arquivo/lote 19–32). */
  cnpjEmpresa: string;
  /** BB payment convênio, 9 digits (header arquivo/lote 33–41; '0126' pinned at 42–45). */
  convenio: string;
  /** Debit agência, 1–5 digits, zero-padded to 5 on the wire (53–57). */
  agencia: string;
  /** Debit agência DV, 1 alphanumeric (58). */
  agenciaDv: string;
  /** Debit conta, 1–12 digits, zero-padded to 12 on the wire (59–70). */
  conta: string;
  /** Debit conta DV, 1 alphanumeric (71). */
  contaDv: string;
  /** Company name as it appears on the file (≤30 chars, 73–102). */
  nomeEmpresa: string;
  /** Arquivo layout version, 3 digits (164–166; must pair with lote '045' per BB's table). */
  versaoLayoutArquivo: string;
}

const CNAB240BB_REQUIRED: (keyof Cnab240BbSettings)[] = [
  "cnpjEmpresa", "convenio", "agencia", "agenciaDv", "conta", "contaDv", "nomeEmpresa", "versaoLayoutArquivo",
];

export function validateCnab240BbSettings(raw: Partial<Cnab240BbSettings> | null): { ok: true; settings: Cnab240BbSettings } | { ok: false; missing: string[] } {
  const s = raw ?? {};
  const missing: string[] = CNAB240BB_REQUIRED.filter((k) => {
    const v = s[k];
    return typeof v !== "string" || v.trim() === "" || v.includes("FILL-ME");
  });
  if (!missing.includes("cnpjEmpresa") && normalizeCpfCnpj(s.cnpjEmpresa!)?.length !== 14) {
    missing.push("cnpjEmpresa (14-digit employer CNPJ with valid check digits)");
  }
  if (!missing.includes("convenio") && !/^\d{9}$/.test(s.convenio!.replace(/\D/g, ""))) {
    missing.push("convenio (9-digit Banco do Brasil payment convênio assigned by your branch)");
  }
  if (!missing.includes("agencia") && normalizeAgencia(s.agencia!) === null) {
    missing.push("agencia (debit agência, up to 5 digits)");
  }
  if (!missing.includes("agenciaDv") && !isValidContaDv(s.agenciaDv!)) {
    missing.push("agenciaDv (debit agência check digit, one character)");
  }
  if (!missing.includes("conta") && normalizeContaNumero(s.conta!) === null) {
    missing.push("conta (debit conta, up to 12 digits)");
  }
  if (!missing.includes("contaDv") && !isValidContaDv(s.contaDv!)) {
    missing.push("contaDv (debit conta check digit, one character)");
  }
  if (!missing.includes("nomeEmpresa") && s.nomeEmpresa!.trim().length > 30) {
    missing.push("nomeEmpresa (max 30 characters, shown on the file)");
  }
  if (!missing.includes("versaoLayoutArquivo") && !/^\d{3}$/.test(s.versaoLayoutArquivo!.trim())) {
    missing.push("versaoLayoutArquivo (3-digit arquivo layout version from your convênio documentation; must pair with lote 045 per Banco do Brasil's version table)");
  }
  if (missing.length) return { ok: false, missing: [...new Set(missing)] };
  return {
    ok: true,
    settings: {
      cnpjEmpresa: normalizeCpfCnpj(s.cnpjEmpresa!)!,
      convenio: s.convenio!.replace(/\D/g, ""),
      agencia: s.agencia!.replace(/\D/g, ""),
      agenciaDv: s.agenciaDv!.trim().toUpperCase(),
      conta: s.conta!.replace(/\D/g, ""),
      contaDv: s.contaDv!.trim().toUpperCase(),
      nomeEmpresa: s.nomeEmpresa!.trim(),
      versaoLayoutArquivo: s.versaoLayoutArquivo!.trim(),
    },
  };
}

export async function loadCnab240BbSettings(orgId: string, runId?: string) {
  const r = (await db.execute<{ originator_secrets_encrypted: string | null }>(sql`
    select p.originator_secrets_encrypted
      from payment_bank_profiles p
      join payment_formats f on f.id = p.payment_format_id and f.org_id = p.org_id
      left join payment_runs r on r.payment_bank_profile_id = p.id and r.org_id = p.org_id
     where p.org_id = ${orgId} and p.is_active and f.rail = 'cnab240_bb_credit'
       and (${runId ?? null}::uuid is null or r.id = ${runId ?? null})
     order by case when r.id is not null then 0 else 1 end, p.created_at
     limit 1
  `));
  return validateCnab240BbSettings(unsealJson<Partial<Cnab240BbSettings>>(r.rows[0]?.originator_secrets_encrypted));
}

export interface Cnab240BbPayment {
  /** Amount in centavos (positive integer, max 15 digits: 13 + 2 implied decimals). */
  amountCents: bigint;
  /** Destination bank, 3 digits: '001' for a Banco do Brasil account, the destination bank for a TED. */
  bancoFavorecido: string;
  /** Destination agência, 1–5 digits (re-validated below). */
  agencia: string;
  /** Destination agência check digit, 1 alphanumeric (re-validated below). */
  agenciaDv: string;
  /** Destination conta, 1–12 digits (re-validated below). */
  conta: string;
  /** Destination conta check digit, 1 alphanumeric (re-validated below). */
  contaDv: string;
  /**
   * Second (combined) check digit, or null for blank. BB accounts carry no
   * second digit (blank); some other banks' accounts do — carried verbatim
   * for TED destinations, never invented.
   */
  dac: string | null;
  /** Favorecido name (≤30 chars after channel mapping). */
  favorecidoNome: string;
  /** '1' CPF or '2' CNPJ (derived from the inscription length, re-checked below). */
  inscricaoTipo: "1" | "2";
  /** Favorecido CPF (11) or CNPJ (14) digits, check digits re-validated below. */
  inscricaoNumero: string;
  /** Company reference for this credit (G064, ≤20 chars after channel mapping). */
  seuNumero: string;
}

export interface Cnab240BbRun {
  settings: Cnab240BbSettings;
  /**
   * Arquivo sequence number (NSA, header 158–163), 6 chars, pre-allocated by
   * the caller from its number sequence — stored, never re-derived.
   */
  nsa: string;
  /**
   * File generation stamp (header data/hora de geração) as a zoned timestamp
   * `YYYY-MM-DDTHH:MM:SS` in the org's business time zone, rendered once by
   * the caller — the same shape SEPA's creationDateTime already carries.
   * A Date instant plus toTimeString() here rendered the server's local clock,
   * so the same run emitted different header bytes per host zone.
   */
  creationDateTime: string;
  /**
   * The payment date (Segmento A data do pagamento): the run's pay date, as
   * an explicit civil day (YYYY-MM-DD) in the org's business time zone.
   */
  paymentDate: string;
  /** Detail payments — split by destination into forma-01 / forma-41 lotes below. */
  payments: Cnab240BbPayment[];
}

/**
 * Build a CNAB 240 Pagamentos credit file in the BANCO DO BRASIL variant:
 * header de arquivo (tipo 0), one header de lote (tipo 1) per forma de
 * lançamento, one Segmento A + Segmento B pair per payment, one trailer de
 * lote (tipo 5) per lote, trailer de arquivo (tipo 9); 240-char records
 * joined with CRLF.
 *
 * Lote discipline — the shape payroll always has. Forma de lançamento is a
 * LOTE-level field, so one lote cannot mix same-bank credits and TEDs:
 * BB-destination payments go in a forma-'01' lote (câmara '000', tipo de
 * serviço '30' — Pagamento de Salários), other-bank payments in a
 * forma-'41' lote (TED outra titularidade, câmara '018'). A single-group
 * file carries a single lote. Poupança (05), DOC (03), PIX (45), cartão
 * salário (60) and ordem de pagamento (10) are out of scope by construction
 * — there is no lote for them, so they cannot be expressed.
 *
 * EVIDENCE. The primary specification is FEBRABAN's *Layout Padrão CNAB 240
 * — Pagamentos* (the G/P field codes used throughout — G001, G060, P001,
 * P010 — are FEBRABAN's), as implemented for Banco do Brasil in BB's own
 * *Layout de Pagamentos — CNAB 240* manual (quoted at length in source 3
 * below; the vendored `PgtVer03BB.xls` reference in that source names the
 * manual vintage). Neither FEBRABAN's nor BB's PDF is openly reachable, so
 * both are named here as the unreachable primaries and the layout below is
 * transcribed from FIVE concordant published sources, none of which is
 * either PDF:
 *
 * 1. Bradesco, *Manual CNAB 240 — Multipag* (2017, bank-published, retrieved
 *    2026-09-20 via a public implementation's vendored copy): the full
 *    position-level tables for header de arquivo (p.14), trailer de arquivo
 *    (p.15), header de lote (p.22) and Segmento A (pp.23–24, every field
 *    01.3A–30.3A with De/Até positions, sizes, formats and defaults) plus
 *    Segmento B (p.24, OBRIGATÓRIO on remessa) and trailer de lote (p.28).
 *    Field codes (G001…P013) are FEBRABAN's own, so this manual doubles as
 *    evidence for the federation standard behind the bank variants.
 * 2. Banco Inter, *Manual CNAB 240 — Pagamentos* (2025, bank-published):
 *    Segmento A para TED (pp.13–14) — positions 1–43, 74–134 and 155–177
 *    identical to (1); 43 = "Campo em branco"; 74–93 blanks-acceptable;
 *    102–104 "BRL"; 105–119 zeros for reais; 135–177 return-only.
 * 3. rubycnab240 (Hamdan85, open source, BB-targeted, implementation quoting
 *    BB's manual field by field): header/lote convênio `9 digits + '0126'`
 *    with BB's wording; tipo de serviço 20/30/98 with '30' = Pagamento de
 *    Salários; forma table 01/02/03/04/05/10/41/43 with the câmara-018 rule
 *    for 03/41/43 and '000' for crédito no BB; Segmento A DAC blank for BB
 *    accounts (BB's wording); the arquivo/lote version pairing table
 *    (031↔050 … 043↔084); trailer fills as emitted.
 * 4. bradesco-cnab240 (thiagosantos, open source implementation of
 *    "Padrão Bradesco Multipag CNAB240 para folha de pagamento"): Segmento
 *    A/B serializers whose field widths sum to exactly 240, header-lote
 *    serviço '30' + forma '01' + lote version '045', A+B pair per employee,
 *    câmara '000' = crédito em conta with '018' TED / '700' DOC noted.
 * 5. OCA l10n-brazil `l10n_br_cnab_structure` data (Akretion/Engenere):
 *    position-level field rows for Itaú/BB/Santander/Sicoob 240 pagamento
 *    structures — BB lote version default '045', BB convênio slot default
 *    '0126', BB densidade default '00000', BB Segmento A/B skeletons,
 *    per-bank payment-way tables (forma 01/41 with câmara 018 for TED,
 *    009 for PIX).
 *
 * Corroboration gradient, stated plainly: every MONEY byte (Segmento A
 * 120–134 valor, 94–101 data, the 24–43 conta block positions, 44–93 nome
 * and seu-número spans) and the whole skeleton (header/trailer arquivo,
 * header/trailer lote, Segmento A 1–177, Segmento B 1–32) agree across (1),
 * (2), (4) and (5), with (3) concurring on the BB flavor — five
 * transcriptions, identical bytes. Bank-divergent by honest design: the
 * 178–230 tail (BB/Bradesco G031 + P005/P013 vs Itaú's ISPB/PIX extension
 * vs Inter's tipo-conta split), the convênio treatment (BB `9 + '0126'` vs
 * Bradesco's 20-char convênio), the arquivo layout version and densidade,
 * P014 (Bradesco '01' vs BB blanks), trailer-lote 42–65 fills (Bradesco
 * zeros vs BB blanks), and the Segmento B tail (BB blanks vs Bradesco
 * P012/P015) — each emitted in the BB flavor per (3) and (5)'s BB rows,
 * with the divergence named here rather than averaged into a layout no
 * bank accepts.
 *
 * Why the BB-flavored envelope choices are shippable: they fail LOUD. BB
 * validates the envelope (NSA/version pairing, convênio, lote counts and
 * the P007 somatória) before processing items — a wrong version, convênio
 * or count rejects the whole file visibly instead of moving money. No
 * envelope byte can redirect a credit; only the five-sourced detail bytes
 * address money, and those never vary by bank.
 *
 * Two conscious refusals, not gaps. (a) The arquivo layout version is
 * REQUIRED tenant configuration, not a default: versions are bank- and
 * era-specific and must pair with the lote version, so a pinned guess risks
 * a parser rejection with no operator remedy — the refusal names the
 * convênio documentation. (b) CPF/CNPJ check digits ARE validated (módulo
 * 11): unlike the Bacs modulus weight tables — pinned tables that
 * false-refuse newly allocated accounts — the Receita algorithm is public,
 * table-free and stable, so a mistyped inscription is refused here rather
 * than riding Segmento B to a confrontation failure.
 */
export function buildCnab240BbFile(run: Cnab240BbRun): string {
  const checked = validateCnab240BbSettings(run.settings);
  if (!checked.ok) {
    throw new PaymentError(`CNAB 240 originator settings are invalid: ${checked.missing.join(", ")}`);
  }
  const s = checked.settings;
  if (run.payments.length === 0) throw new PaymentError("run has no payments to export");
  if (!/^\d{6}$/.test(run.nsa) || /^0+$/.test(run.nsa)) {
    throw new PaymentError("CNAB 240 NSA must be 6 digits and greater than zero");
  }

  // CNAB channel text: uppercase, unaccented. Accents strip deterministically
  // (NFD + mark removal) and anything outside the channel set becomes a
  // space — mirroring the channel rather than letting the bank mangle names
  // unpredictably. Lengths are the published field widths; over-length text
  // fails here rather than shifting every field after it. (Non-ASCII never
  // reaches this writer through the payroll path either: the artifact
  // refuses non-ASCII on fixed-width rails before rendering.)
  const text = (value: string, len: number, what: string, allowBlank = false): string => {
    const mapped = value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .replace(/[^A-Z0-9 .,/&+\-:;()?]/g, " ")
      .slice(0, len);
    if (!allowBlank && mapped.trim() === "") throw new PaymentError(`CNAB 240 ${what} must not be blank`);
    if (value.trim() !== "" && mapped.trim() === "") {
      throw new PaymentError(`CNAB 240 ${what} has no representable characters`);
    }
    return mapped.padEnd(len, " ");
  };
  const digits = (value: bigint | string | number, len: number, what: string): string => {
    const raw = String(value);
    if (!/^\d+$/.test(raw)) throw new PaymentError(`CNAB 240 ${what} "${raw}" must be numeric`);
    if (raw.length > len) {
      throw new PaymentError(`CNAB 240 ${what} ${raw} does not fit in ${len} digits — split the pay run`);
    }
    return raw.padStart(len, "0");
  };
  const centavos = (value: bigint, len: number, what: string): string => {
    if (value <= 0n) throw new PaymentError("payment amounts must be positive");
    return digits(value, len, what);
  };
  // DDMMYYYY from an already-zoned civil day (YYYY-MM-DD): UTC accessors on
  // the parsed date read the same parts on every host. Local
  // getDate/getMonth/getFullYear here would reintroduce server-zone bytes.
  const ddmmaaaa = (iso: string, what: string): string => {
    let day: string;
    let month: string;
    let year: number;
    try {
      const parsed = parseIsoDate(iso);
      const p = (n: number) => String(n).padStart(2, "0");
      day = p(parsed.getUTCDate());
      month = p(parsed.getUTCMonth() + 1);
      year = parsed.getUTCFullYear();
    } catch {
      throw new PaymentError(`CNAB 240 ${what} "${iso}" is not a valid YYYY-MM-DD civil day`);
    }
    return `${day}${month}${year}`;
  };
  // HHMMSS from an already-zoned `YYYY-MM-DDTHH:MM:SS` stamp — sliced, never
  // read off a Date, so no host clock leaks into the header.
  const hhmmss = (stamp: string): string => {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(stamp);
    if (!match) {
      throw new PaymentError(
        `CNAB 240 file generation stamp "${stamp}" is not a valid YYYY-MM-DDTHH:MM:SS zoned timestamp`,
      );
    }
    try {
      parseIsoDate(`${match[1]}-${match[2]}-${match[3]}`);
    } catch {
      throw new PaymentError(
        `CNAB 240 file generation stamp "${stamp}" is not a valid YYYY-MM-DDTHH:MM:SS zoned timestamp`,
      );
    }
    return `${match[4]}${match[5]}${match[6]}`;
  };
  const agencia = (value: string, what: string): string => {
    const normal = normalizeAgencia(value);
    if (!normal) throw new PaymentError(`CNAB 240 ${what} "${value}" is not an agência (up to 5 digits)`);
    return normal;
  };
  const conta = (value: string, what: string): string => {
    const normal = normalizeContaNumero(value);
    if (!normal) throw new PaymentError(`CNAB 240 ${what} "${value}" is not a conta (up to 12 digits)`);
    return normal;
  };
  const dv = (value: string, what: string): string => {
    if (!isValidContaDv(value)) throw new PaymentError(`CNAB 240 ${what} must be a single check-digit character`);
    return value.trim().toUpperCase();
  };

  const empresaAg = agencia(s.agencia, "debit agência");
  const empresaConta = conta(s.conta, "debit conta");
  const empresaAgDv = dv(s.agenciaDv, "debit agência DV");
  const empresaContaDv = dv(s.contaDv, "debit conta DV");
  const nomeEmpresa = text(s.nomeEmpresa, 30, "company name");
  const cnpj = normalizeCpfCnpj(s.cnpjEmpresa);
  if (cnpj?.length !== 14) throw new PaymentError("CNAB 240 employer inscription must be a 14-digit CNPJ");

  // -- header de arquivo (tipo 0, lote 0000) ---------------------------------
  // (1) p.14; (3)/(5) BB rows: convênio(9) + '0126' + 5 + 2 blanks; NSA at
  // 158–163; arquivo layout version at 164–166 (tenant-configured, paired
  // with lote 045); densidade '00000' per (3) and (5)'s BB default
  // ("INFORMAR 00000").
  const headerArquivo =
    "001" + // 1–3 banco na compensação (this variant transmits to BB)
    "0000" + // 4–7 lote de serviço
    "0" + // 8 tipo de registro
    " ".repeat(9) + // 9–17 uso exclusivo FEBRABAN
    "2" + // 18 tipo de inscrição da empresa (CNPJ)
    cnpj + // 19–32 número de inscrição da empresa
    digits(s.convenio, 9, "convênio") + // 33–41 convênio no banco
    "0126" + // 42–45 cobrança-convênio slot: '0126' para pagamento (3)
    " ".repeat(5) + // 46–50 uso reservado do banco
    " ".repeat(2) + // 51–52 (3)/(5) leave blank; NOT a test flag
    empresaAg + // 53–57 agência mantenedora
    empresaAgDv + // 58 DV agência
    empresaConta + // 59–70 conta corrente
    empresaContaDv + // 71 DV conta
    "0" + // 72 DV ag/conta: '0' for a BB debit account (3)
    nomeEmpresa + // 73–102 nome da empresa
    text("BANCO DO BRASIL", 30, "bank name") + // 103–132 nome do banco
    " ".repeat(10) + // 133–142 uso exclusivo FEBRABAN
    "1" + // 143 remessa
    ddmmaaaa(run.creationDateTime.slice(0, 10), "file generation date") + // 144–151 data de geração
    hhmmss(run.creationDateTime) + // 152–157 hora de geração HHMMSS
    run.nsa + // 158–163 NSA
    digits(s.versaoLayoutArquivo, 3, "arquivo layout version") + // 164–166 versão do layout
    "00000" + // 167–171 densidade
    " ".repeat(20) + // 172–191 reservado banco
    " ".repeat(20) + // 192–211 reservado empresa
    " ".repeat(29); // 212–240 uso exclusivo FEBRABAN
  if (headerArquivo.length !== 240) throw new PaymentError("internal error: CNAB 240 header de arquivo is not 240 characters");

  // -- lotes: forma 01 (crédito em conta BB) and forma 41 (TED) ----------------
  // One lote per forma — forma is lote-level, so mixing would misdescribe
  // credits. Tipo de serviço '30' (Pagamento de Salários) on every lote:
  // (3) quotes BB admitting only 20/30/98, (4) emits '30' for folha.
  const groups: { forma: "01" | "41"; camara: "000" | "018"; payments: Cnab240BbPayment[] }[] = [];
  for (const p of run.payments) {
    if (!isValidBancoCode(p.bancoFavorecido)) {
      throw new PaymentError(`CNAB 240 destination bank "${p.bancoFavorecido}" must be 3 digits`);
    }
    const ted = p.bancoFavorecido !== "001";
    let group = groups.find((g) => g.forma === (ted ? "41" : "01"));
    if (!group) {
      group = { forma: ted ? "41" : "01", camara: ted ? "018" : "000", payments: [] };
      groups.push(group);
    }
    group.payments.push(p);
  }
  // Deterministic lote order: the same-bank lote first, then TED — the same
  // inputs always produce the same characters.
  groups.sort((a, b) => a.forma.localeCompare(b.forma));

  const records: string[] = [headerArquivo];
  let loteNo = 0;
  for (const group of groups) {
    loteNo += 1;
    const lote = digits(loteNo, 4, "lote number");
    // -- header de lote (tipo 1) ------------------------------------------------
    // (1) p.22; (3)/(5) BB rows: convênio + '0126' + blanks; P014 at
    // 223–224 left BLANK — Bradesco carries '01' there but both BB-flavored
    // transcriptions blank it, so the BB variant does too. Endereço
    // 143–222 optional: blank (no company address on file).
    const headerLote =
      "001" + // 1–3 banco
      lote + // 4–7 lote de serviço
      "1" + // 8 tipo de registro
      "C" + // 9 tipo da operação (crédito)
      "30" + // 10–11 tipo de serviço: Pagamento de Salários
      group.forma + // 12–13 forma de lançamento: 01 crédito em conta, 41 TED outra titularidade
      "045" + // 14–16 versão do layout do lote: '045' in (1), (4) and (5)'s BB default
      " " + // 17 uso exclusivo FEBRABAN
      "2" + // 18 tipo de inscrição da empresa (CNPJ)
      cnpj + // 19–32 número de inscrição da empresa
      digits(s.convenio, 9, "convênio") + // 33–41 convênio
      "0126" + // 42–45 '0126' para pagamento (3)
      " ".repeat(5) + // 46–50 uso reservado do banco
      " ".repeat(2) + // 51–52 blank (3)
      empresaAg + // 53–57 agência
      empresaAgDv + // 58 DV agência
      empresaConta + // 59–70 conta
      empresaContaDv + // 71 DV conta
      "0" + // 72 DV ag/conta: '0' for a BB debit account (3)
      nomeEmpresa + // 73–102 nome da empresa
      " ".repeat(40) + // 103–142 Informação 1: blank for salary (G031 is SIAPE/depósito-judicial only)
      " ".repeat(80) + // 143–222 endereço da empresa: optional, blank
      " ".repeat(8) + // 223–230 blank on the BB variant (see above)
      " ".repeat(10); // 231–240 ocorrências (retorno)
    if (headerLote.length !== 240) throw new PaymentError("internal error: CNAB 240 header de lote is not 240 characters");
    records.push(headerLote);

    // -- Segmentos A + B -------------------------------------------------------
    let seq = 0;
    let loteTotal = 0n;
    for (const p of group.payments) {
      seq += 1;
      if (seq > 99999) throw new PaymentError("CNAB 240 lote holds at most 99999 records — split the pay run");
      const seqA = digits(seq, 5, "record sequence");
      const inscricao = normalizeCpfCnpj(p.inscricaoNumero);
      if (!inscricao) {
        throw new PaymentError(`CNAB 240 inscription "${p.inscricaoNumero}" is not a valid CPF/CNPJ`);
      }
      const tipo = inscricaoTipoFor(inscricao);
      if (tipo !== p.inscricaoTipo) {
        throw new PaymentError("internal error: CNAB 240 inscription type does not match its length");
      }
      // -- Segmento A: the credit (1) pp.23–24; (2) pp.13–14; (3)–(5) ---------
      const segmentoA =
        "001" + // 1–3 banco
        lote + // 4–7 lote
        "3" + // 8 tipo de registro
        seqA + // 9–13 seqüencial no lote
        "A" + // 14 segmento
        "0" + // 15 tipo de movimento: inclusão
        "00" + // 16–17 instrução: inclusão de registro detalhe liberado
        group.camara + // 18–20 câmara: '000' crédito em conta, '018' TED
        digits(p.bancoFavorecido, 3, "destination bank") + // 21–23 banco do favorecido
        agencia(p.agencia, "favorecido agência") + // 24–28 agência
        dv(p.agenciaDv, "favorecido agência DV") + // 29 DV agência
        conta(p.conta, "favorecido conta") + // 30–41 conta
        dv(p.contaDv, "favorecido conta DV") + // 42 DV conta
        (p.dac == null || p.dac === "" ? " " : dv(p.dac, "favorecido DAC")) + // 43 DAC: blank for BB accounts (3); second DV carried verbatim for TED
        text(p.favorecidoNome, 30, "favorecido name") + // 44–73 nome do favorecido
        text(p.seuNumero, 20, "seu número", true) + // 74–93 seu número (G064): blank acceptable per (2)
        ddmmaaaa(run.paymentDate, "payment date") + // 94–101 data do pagamento
        "BRL" + // 102–104 tipo da moeda: (2) kills the SISPAG-'009' reading for this variant
        "0".repeat(15) + // 105–119 quantidade da moeda: zeros for reais (1)(2)(3)
        centavos(p.amountCents, 15, "payment amount") + // 120–134 valor (13+2)
        " ".repeat(20) + // 135–154 nosso número: blank on remessa, assigned on return
        "0".repeat(8) + // 155–162 data real: return-only, zeros on remessa (3)
        "0".repeat(15) + // 163–177 valor real: return-only, zeros on remessa (3)
        " ".repeat(40) + // 178–217 Informação 2: blank for salary (G031 is SIAPE/depósito-judicial only)
        " ".repeat(2) + // 218–219 finalidade DOC (P005): no DOC on this rail
        " ".repeat(5) + // 220–224 finalidade TED (P011): blank is accepted BB-side per (3)/(5); Inter documents 00004=salários for Inter-transmitted files
        " ".repeat(2) + // 225–226 finalidade complementar (P013): blank; '06' (salários) exists in the table but no transcription emits it for salary
        " ".repeat(3) + // 227–229 uso exclusivo FEBRABAN
        "0" + // 230 aviso: '0' não emite (1)(4)(5); (3) sends blank for same-bank — noted, '0' is the documented value
        " ".repeat(10); // 231–240 ocorrências (retorno)
      if (segmentoA.length !== 240) throw new PaymentError("internal error: CNAB 240 Segmento A is not 240 characters");
      records.push(segmentoA);
      loteTotal += p.amountCents;

      seq += 1;
      if (seq > 99999) throw new PaymentError("CNAB 240 lote holds at most 99999 records — split the pay run");
      // -- Segmento B: the inscription (1) p.24 OBRIGATÓRIO; (3) -------------
      // Address block 33–225 blank: (3)'s BB transcription blanks all 193
      // (no per-employee address needed); (4) fills the employer's address,
      // a Bradesco liberty, not a requirement. Inscription at 18–32 is the
      // load-bearing field (required for TED; emitted always).
      const segmentoB =
        "001" + // 1–3 banco
        lote + // 4–7 lote
        "3" + // 8 tipo de registro
        digits(seq, 5, "record sequence") + // 9–13 seqüencial (A+1)
        "B" + // 14 segmento
        " ".repeat(3) + // 15–17 uso exclusivo FEBRABAN
        tipo + // 18 tipo de inscrição: 1 CPF, 2 CNPJ
        digits(inscricao, 14, "inscription") + // 19–32 número: 14 wide, CPF zero-padded left per (1)/(3)/(4)
        " ".repeat(193) + // 33–225 address block: blank (see above)
        "0" + // 226 aviso: '0' (3)
        " ".repeat(6) + // 227–232 blank on the BB variant ((1)'s P012/SIAPE and (2)'s ISPB live here on other flavors)
        " ".repeat(8); // 233–240 blank on remessa (ocorrências on return)
      if (segmentoB.length !== 240) throw new PaymentError("internal error: CNAB 240 Segmento B is not 240 characters");
      records.push(segmentoB);
    }

    // -- trailer de lote (tipo 5) ------------------------------------------------
    // (1) p.28: 18–23 record count (header + details + trailer), 24–41 P007
    // somatória 16+2, 42–59 G058, 60–65 G066, 66–230 blanks, 231–240
    // ocorrências. G058/G066 fill: (3)'s BB transcription blanks them;
    // (4)'s Bradesco flow zero-fills — the BB flavor is emitted, the
    // divergence named, and a wrong fill rejects the file visibly.
    const trailerLote =
      "001" + // 1–3 banco
      lote + // 4–7 lote
      "5" + // 8 tipo de registro
      " ".repeat(9) + // 9–17 uso exclusivo FEBRABAN
      digits(seq + 2, 6, "lote record count") + // 18–23 qtde (header + details + trailer)
      centavos(loteTotal, 18, "lote total") + // 24–41 somatória 16+2
      " ".repeat(18) + // 42–59 somatória qtde moedas: blank on the BB variant (see above)
      " ".repeat(6) + // 60–65 número aviso débito: blank on the BB variant
      " ".repeat(165) + // 66–230 uso exclusivo FEBRABAN
      " ".repeat(10); // 231–240 ocorrências (retorno)
    if (trailerLote.length !== 240) throw new PaymentError("internal error: CNAB 240 trailer de lote is not 240 characters");
    records.push(trailerLote);
  }

  // -- trailer de arquivo (tipo 9, lote 9999) ------------------------------------
  // (1) p.15; (3)/(4)/(5): 18–23 lote count, 24–29 whole-file record count
  // (every tipo 0/1/3/5/9 record), 30–35 zeros (no conciliação), 36–240 blanks.
  const trailerArquivo =
    "001" + // 1–3 banco
    "9999" + // 4–7 lote de serviço
    "9" + // 8 tipo de registro
    " ".repeat(9) + // 9–17 uso exclusivo FEBRABAN
    digits(groups.length, 6, "lote count") + // 18–23 qtde de lotes
    digits(records.length + 1, 6, "file record count") + // 24–29 qtde de registros (incl. this trailer)
    "0".repeat(6) + // 30–35 qtde de contas conciliação
    " ".repeat(205); // 36–240 uso exclusivo FEBRABAN
  if (trailerArquivo.length !== 240) throw new PaymentError("internal error: CNAB 240 trailer de arquivo is not 240 characters");
  records.push(trailerArquivo);

  return records.join("\r\n") + "\r\n";
}
