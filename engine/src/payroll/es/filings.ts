/**
 * The ES pack's filing declaration: AEAT retenciones + TGSS settlement.
 *
 * Declared as PROGRAM TYPES (registrations the employer holds), with no
 * year-end builders yet:
 * - IRPF retentions are settled on AEAT Modelo 111 (trimestral; mensual para
 *   grandes empresas) with annual resumen on Modelo 190. No 111/190 builder
 *   exists, so `yearEnd` is empty rather than approximate.
 * - Seguridad Social settles monthly through the Sistema RED / SILTRA
 *   (documentos RNT y RLC, antigua TC1/TC2) against the employer's código de
 *   cuenta de cotización (CCC) with the TGSS — hence the one program type.
 *
 * Citations are the agency publications, not URLs: LIRPF art. 99 (obligación
 * de retener), RIRPF arts. 71–94 (retenciones sobre rendimientos del trabajo),
 * Orden PJC/297/2026 (cotización 2026).
 */
import type { PayrollPackFilings } from "../filing-registry.ts";

export function esPackFilings(): PayrollPackFilings {
  return {
    country: "ES",
    programTypes: [
      {
        key: "es_tgss_ccc",
        label: "TGSS código de cuenta de cotización (CCC)",
        requiresRegion: true,
      },
    ],
    yearEnd: [],
  };
}
