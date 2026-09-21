/**
 * The ES pack's filing declaration: IRPF retentions settle with the AEAT,
 * Seguridad Social with the TGSS — different agencies, different channels.
 *
 * - Modelo 190 (annual resumen, AEAT): one perceptor row per employee and
 *   province off committed stubs, each rendering the certificado de
 *   retenciones e ingresos a cuenta the employer must hand the employee
 *   (RIRPF art. 108.3). Clave A, no subclave — ./modelo-190.ts.
 * - Modelo 111 (trimestral autoliquidación, AEAT): one aggregate row per
 *   quarter off committed stubs (casillas 01/02/03). The US 941 is the shape
 *   copied: population + slip + amendment real, download refused by name.
 * - Seguridad Social (monthly, TGSS): NO filing is declared. Settlement runs
 *   through Sistema RED / SILTRA (documentos RNT y RLC against the CCC), and
 *   no RNT/RLC file is built — settle through Sistema RED directly. The CCC
 *   program type below is the account that channel files under, not a return.
 *
 * Citations are the agency publications, not URLs: LIRPF art. 99 (obligación
 * de retener), RIRPF arts. 71–94 (retenciones sobre rendimientos del
 * trabajo), RIRPF art. 108.3 (certificación al perceptor), Orden PJC/297/2026
 * (cotización 2026), AEAT Diseños lógicos Modelo 190 ejercicio 2025
 * (claves/subclaves), Instrucciones del Modelo 111 (casillas 01–03).
 */
import type { PayrollFilingRowScope, PayrollPackFilings } from "../filing-registry.ts";
import {
  es111Population,
  es111Slip,
  es190CorrectionSlip,
  es190Population,
  es190Slip,
} from "./yearend.ts";

/**
 * The lax UUID shape, copied from the web layer's shared guard
 * (`isFilingRowUuid` in ../filing-registry.ts) the way CA's row grammar keeps
 * its own copy: this module must not runtime-import the registry (see the
 * cycle note on the lazy builder below), so the grammar cannot call it.
 */
const ES_ROW_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The 190 row grammar, as the inverse of es190Population's
 * `employee:province` construction. Owned HERE, beside the declaration — the
 * subsidiary-scope guard parses through the declaration, never its own copy
 * of this shape.
 */
export function parseEs190RowId(rowId: string): PayrollFilingRowScope | null {
  const parts = rowId.split(":");
  const employee = parts[0] ?? "";
  const province = parts[1] ?? "";
  if (parts.length !== 2 || !ES_ROW_UUID_RE.test(employee) || !/^[A-Z]{2}$/.test(province)) {
    return null;
  }
  return { employees: [employee], accounts: [] };
}

/**
 * The 111 row grammar, as the inverse of es111Population's `QN`
 * construction. Quarterly aggregates file under the employer's NIF, not
 * under a filing account, so no account parses out of them.
 */
export function parseEs111RowId(rowId: string): PayrollFilingRowScope | null {
  if (!/^Q[1-4]$/.test(rowId)) return null;
  return { employees: [], accounts: [] };
}

/**
 * Built LAZILY (first lookup, not module evaluation): this module sits in an
 * import cycle — the registry reaches it, it reaches the builders, and the
 * builders reach the registry — so touching another module's consts during
 * evaluation is a TDZ crash whenever the other module happens to load first.
 * Everything inside the declaration is therefore only dereferenced at call
 * time.
 */
let cached: PayrollPackFilings | null = null;

export function esPackFilings(): PayrollPackFilings {
  cached ??= buildEsPackFilings();
  return cached;
}

function buildEsPackFilings(): PayrollPackFilings {
  return {
    country: "ES",
    programTypes: [
      {
        key: "es_tgss_ccc",
        label: "TGSS código de cuenta de cotización (CCC)",
        requiresRegion: true,
      },
    ],
    yearEnd: [
      {
        key: "190",
        label: "Modelo 190 — Resumen anual de retenciones e ingresos a cuenta",
        cadence: "annual",
        description:
          "Per-employee certificate of IRPF withheld on employment income (clave A, "
          + "sin subclave): percepción íntegra and retenciones practicadas off committed "
          + "stubs, rendered as the certificado de retenciones the employer must issue.",
        emptyText: "No committed ES pay stubs for this year.",
        population: (orgId, taxYear) => es190Population(orgId, taxYear),
        parseRowId: parseEs190RowId,
        slip: { build: (orgId, taxYear, rowId) => es190Slip(orgId, taxYear, rowId) },
        downloadRefusal:
          "the ES pack produces no Modelo 190 electronic file (diseños lógicos registro) — "
          + "the perceptor figures are complete on screen; transmit the resumen through "
          + "AEAT Sede directly",
        // A filed 190 is corrected by re-filing the SAME return: complementaria
        // (omitted percepciones only) or sustitutiva (full replacement quoting
        // the prior justificante). Both restate figures, so this filing
        // declares `amended` and ONLY `amended` — never cancelled.
        amendment: {
          supported: true,
          revisions: ["amended"],
          vehicle: "same_form",
          formLabel: "Modelo 190 — declaración complementaria o sustitutiva",
          slip: { build: async (row) => es190CorrectionSlip(row) },
          downloadRefusal:
            "no electronic complementaria/sustitutiva file is generated, the same gap the "
            + "original Modelo 190 declares — the restated figures above are complete; file "
            + "the correction with its 13-digit justificante through AEAT Sede",
        },
      },
      {
        key: "111",
        label: "Modelo 111 — Retenciones e ingresos a cuenta (trimestral)",
        cadence: "quarterly",
        description:
          "Quarterly IRPF withholding worksheet for ES-pack employees: perceptores, "
          + "percepciones and retenciones per calendar quarter off committed stubs "
          + "(casillas 01/02/03).",
        emptyText: "No committed ES pay stubs for this year.",
        population: (orgId, taxYear) => es111Population(orgId, taxYear),
        parseRowId: parseEs111RowId,
        slip: { build: (orgId, taxYear, rowId) => es111Slip(orgId, taxYear, rowId) },
        downloadRefusal:
          "the ES pack produces no Modelo 111 electronic transmission — the quarterly "
          + "figures are complete on screen; file the autoliquidación through AEAT Sede directly",
        // The 111's correction vehicle is not transcribed to a citable
        // instruction in this tree, so no correction slip is produced here —
        // an uncited complementaria would inherit another form's mechanics.
        // The re-computed quarter above IS the corrected figure set.
        amendment: {
          supported: false,
          refusal:
            "a filed Modelo 111 is corrected outside the product by presenting a declaración "
            + "complementaria through AEAT Sede — the quarter re-rendered from committed stubs "
            + "above carries the corrected figures; OpenBooks builds no AEAT correction vehicle "
            + "of its own",
        },
      },
    ],
  };
}
