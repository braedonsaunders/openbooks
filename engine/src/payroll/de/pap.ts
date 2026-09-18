/**
 * Germany — Programmablaufplan für den Lohnsteuerabzug 2026 (PAP 2026).
 *
 * STEP 1 (shard payroll-de-pap): the PAP is OBTAINABLE from the BMF's own
 * host. Availability answer, committed first:
 *
 * - Exact URL (Anlage 1, the machine-calculation PAP itself):
 *   https://www.bundesfinanzministerium.de/Content/DE/Downloads/Steuern/Steuerarten/Lohnsteuer/Programmablaufplan/2025-11-12-PAP-2026-anlage-1.pdf?__blob=publicationFile
 * - Covering letter (BMF-Schreiben vom 12. November 2025, GZ
 *   IV C 5 - S 2361/00025/016/028, "Betreff: Programmablaufplan für die
 *   maschinelle Berechnung der vom Arbeitslohn einzubehaltenden Lohnsteuer
 *   ... jeweils für 2026 ..."):
 *   https://www.bundesfinanzministerium.de/Content/DE/Downloads/Steuern/Steuerarten/Lohnsteuer/Programmablaufplan/2025-11-12-PAP-2026-bmf-schreiben.pdf?__blob=publicationFile
 * - Document date: "Stand: 12.11.2025 (endgültig)", Anlage 1, 40 pages,
 *   Title "Programmablaufplan für die maschinelle Berechnung der vom
 *   Arbeitslohn einzubehaltenden Lohnsteuer, des Solidaritätszuschlags und
 *   der Maßstabsteuer für die Kirchenlohnsteuer für 2026", Author
 *   Bundesministerium der Finanzen.
 *
 * Quoted opening operative step (PAP §1, "Gesetzliche Grundlagen/
 * Allgemeines"), proving this is the real document:
 * "Der Programmablaufplan enthält gem. § 39b Absatz 6 EStG: a) die
 * Berechnung der vom laufenden Arbeitslohn nach § 39b Absatz 2 EStG
 * einzubehaltenden Lohnsteuer für Lohnzahlungszeiträume, die nach dem
 * 31. Dezember 2025, aber vor dem 1. Januar 2027 enden, b) die Berechnung
 * der von sonstigen Bezügen nach § 39b Absatz 3 Satz 1 bis 8 EStG
 * einzubehaltenden Lohnsteuer für sonstige Bezüge, die nach dem
 * 31. Dezember 2025, aber vor dem 1. Januar 2027 zufließen, c) die
 * Berechnung des Solidaritätszuschlags auf laufenden Arbeitslohn ... und
 * auf sonstige Bezüge ..., d) die Ermittlung der Bemessungsgrundlage für
 * die einzubehaltende Kirchenlohnsteuer (Minderung der ermittelten
 * Lohnsteuer nach § 51a EStG)."
 *
 * Sourcing outcomes per host (recorded distinctly):
 * - bundesfinanzministerium.de HTML landing/topic pages: 302 to an Imperva
 *   WAF challenge body (`__uzdbm_`/`SSJSConnectorObj` script, "302 Found") —
 *   WAF challenge, NOT content. Do not cite HTML pages from this host.
 * - bundesfinanzministerium.de direct PDF download URLs: 200
 *   `application/pdf` with real `%PDF-1.6` bytes (Schreiben 113 794 bytes
 *   ending `%%EOF`; Anlage 1 481 972 bytes, 40 pages). Obtainable.
 * - bundesanzeiger.de and the BMF Lohn-/Einkommensteuerrechner pages were
 *   NOT tried: the PAP was found at the first host, so no further probing
 *   was needed.
 *
 * Engine status: NOT YET IMPLEMENTED. The transcription of sections 3–5
 * (Eingangsparameter, interne Felder, Programmablaufplan 2026) into this
 * file is Step 2 and lands as its own commit. Until then `installable`
 * stays false and `computeStatutory` keeps refusing 2026 by name.
 */

export const DE_PAP_2026_SOURCE = {
  url: "https://www.bundesfinanzministerium.de/Content/DE/Downloads/Steuern/Steuerarten/Lohnsteuer/Programmablaufplan/2025-11-12-PAP-2026-anlage-1.pdf?__blob=publicationFile",
  stand: "12.11.2025 (endgültig)",
  pages: 40,
  implemented: false,
} as const;
