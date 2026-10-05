import { toFilingCents, type OssReturn } from "./oss-return.ts";

/**
 * Member-state transport layouts for a prepared OSS return.
 *
 * The filed dataset is harmonized across the Union (consumption state, VAT
 * rate, taxable base, VAT, corrections against their original quarter); what
 * differs per member state of identification is the portal and the shape it
 * accepts. Each layout below carries every filed figure plus the translation
 * evidence digest, and names its portal in the file: Germany (BZSt online
 * portal), France (the French OSS return on impots.gouv.fr), the Netherlands
 * (Mijn Belastingdienst Zakelijk) as semicolon CSV, and Ireland (ROS upload)
 * as XML. These are transport layouts for hand-keying or file upload — the
 * operator confirms the field mapping against the portal's current template
 * before uploading, since portals revise their templates without notice.
 */

export type OssMemberState = "DE" | "FR" | "NL" | "IE";

const PORTAL: Record<OssMemberState, { portal: string; format: "csv" | "xml" }> = {
  DE: { portal: "BZSt online portal (BOP)", format: "csv" },
  FR: { portal: "French OSS return (impots.gouv.fr)", format: "csv" },
  NL: { portal: "Mijn Belastingdienst Zakelijk", format: "csv" },
  IE: { portal: "Irish Revenue ROS upload", format: "xml" },
};

function digestFor(oss: OssReturn): string {
  return oss.fx.length === 0 ? "EUR" : oss.fx.map((entry) => `${entry.currency}@${entry.rateAsOf}#${entry.digest.slice(0, 12)}`).join("|");
}

/**
 * Semicolon CSV per member-state portal column order. Rates and amounts
 * carry two decimals as filed; corrections flag their original quarter.
 */
export function ossReturnToMemberStateCsv(oss: OssReturn, state: Exclude<OssMemberState, "IE">): string {
  const digest = digestFor(oss);
  if (state === "DE") {
    const header =
      "Identifikationsstaat;Registrierungsnummer;Zeitraum_von;Zeitraum_bis;Satzart;Bestimmungsland;Steuersatz;Bemessungsgrundlage;Steuerbetrag;Korrekturquartal;Beleg";
    const rows = oss.lines.map((line) =>
      [
        oss.identificationState,
        oss.registrationNumber,
        oss.from,
        oss.to,
        line.kind === "correction" ? "KORREKTUR" : "MELDUNG",
        line.consumptionCountry,
        toFilingCents(line.ratePercent),
        toFilingCents(line.baseAmount),
        toFilingCents(line.taxAmount),
        line.correctionQuarter ?? "",
        digest,
      ].join(";"),
    );
    return [`# OSS transport for ${PORTAL.DE.portal}; confirm the field mapping against the portal template before upload`, header, ...rows].join("\n");
  }
  if (state === "FR") {
    const header =
      "regime;etat_identification;numero_identification;periode_du;periode_au;ligne;etat_consommation;taux_tva;base_ht;tva;trimestre_correction;preuve";
    const rows = oss.lines.map((line) =>
      [
        oss.scheme,
        oss.identificationState,
        oss.registrationNumber,
        oss.from,
        oss.to,
        line.kind === "correction" ? "CORRECTION" : "COURANT",
        line.consumptionCountry,
        toFilingCents(line.ratePercent),
        toFilingCents(line.baseAmount),
        toFilingCents(line.taxAmount),
        line.correctionQuarter ?? "",
        digest,
      ].join(";"),
    );
    return [`# Transport OSS pour ${PORTAL.FR.portal} ; verifier la correspondance des champs avec le modele du portail avant televersement`, header, ...rows].join("\n");
  }
  const header =
    "regeling;identificatiestaat;identificatienummer;tijdvak_van;tijdvak_tot;regel;verbruiksland;btw_tarief;grondslag;btw_bedrag;correctiekwartaal;bewijs";
  const rows = oss.lines.map((line) =>
    [
      oss.scheme,
      oss.identificationState,
      oss.registrationNumber,
      oss.from,
      oss.to,
      line.kind === "correction" ? "CORRECTIE" : "AANGIFTE",
      line.consumptionCountry,
      toFilingCents(line.ratePercent),
      toFilingCents(line.baseAmount),
      toFilingCents(line.taxAmount),
      line.correctionQuarter ?? "",
      digest,
    ].join(";"),
  );
  return [`# OSS-transport voor ${PORTAL.NL.portal}; controleer de veldtoewijzing aan de hand van de portalsjabloon voor het uploaden`, header, ...rows].join("\n");
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Irish ROS-style XML envelope: header, one consumption-state block per
 * rate, corrections grouped with their original quarter, and the
 * translation-evidence block. Amounts carry two decimals as filed.
 */
export function ossReturnToIrelandXml(oss: OssReturn): string {
  const out: string[] = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  out.push(`<!-- OSS transport for ${PORTAL.IE.portal}; confirm the field mapping against the portal template before upload -->`);
  out.push(
    `<OssReturn scheme="${escapeXml(oss.scheme)}" identificationState="${escapeXml(oss.identificationState)}" registrationNumber="${escapeXml(oss.registrationNumber)}" periodFrom="${escapeXml(oss.from)}" periodTo="${escapeXml(oss.to)}" currency="EUR">`,
  );
  for (const line of oss.lines) {
    out.push(
      `  <Supply kind="${line.kind}" consumptionCountry="${escapeXml(line.consumptionCountry)}" vatRate="${escapeXml(toFilingCents(line.ratePercent))}" baseAmount="${escapeXml(toFilingCents(line.baseAmount))}" vatAmount="${escapeXml(toFilingCents(line.taxAmount))}"${line.correctionQuarter ? ` correctionQuarter="${escapeXml(line.correctionQuarter)}"` : ""} />`,
    );
  }
  out.push(`  <Totals baseAmount="${escapeXml(toFilingCents(oss.totalBase))}" vatAmount="${escapeXml(toFilingCents(oss.totalTax))}" />`);
  if (oss.fx.length === 0) {
    out.push(`  <Translation native="EUR" />`);
  } else {
    for (const entry of oss.fx) {
      out.push(
        `  <Translation currency="${escapeXml(entry.currency)}" rate="${escapeXml(entry.rate)}" rateAsOf="${escapeXml(entry.rateAsOf)}" source="${escapeXml(entry.rateSource)}" digest="${escapeXml(entry.digest)}" />`,
      );
    }
  }
  out.push(`</OssReturn>`);
  return out.join("\n");
}

/** Dispatch to the member state's transport layout. */
export function ossReturnToMemberState(oss: OssReturn, state: OssMemberState): string {
  if (state === "IE") return ossReturnToIrelandXml(oss);
  return ossReturnToMemberStateCsv(oss, state);
}
