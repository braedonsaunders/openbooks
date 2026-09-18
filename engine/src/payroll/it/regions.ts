/**
 * Italy's regions — the withholding geography of the IT payroll pack.
 *
 * Codes are the official two-digit ISTAT region codes ("01" Piemonte …
 * "20" Sardegna), the only unambiguous national scheme: Italy has no
 * official two-letter region abbreviations, and inventing one would collide
 * with the day somebody else invents a different one.
 *
 * Why regions at all: the national IRPEF is one table, but the addizionale
 * regionale all'IRPEF is set region by region (D.Lgs. 15 dicembre 1997,
 * n. 446) and follows the employee's fiscal domicile, while the addizionale
 * comunale all'IRPEF is set comune by comune (D.Lgs. 28 settembre 1998,
 * n. 360, ~7,900 deliberating comuni a year). A withholding engine must know
 * which region's surcharge applies before it can compute a number, so the
 * pack names every region even though none is implemented yet.
 *
 * Trentino-Alto Adige/Südtirol (04) is special inside this list: the
 * addizionale regionale there is set by the two autonomous provinces of
 * Trento and Bolzano, not by the region. That split is named here so the
 * future transcription does not silently apply one region-wide rate.
 */
export interface ItRegion {
  /** Two-digit ISTAT code, "01"–"20". */
  code: string;
  /** Italian proper noun, as the deliberations spell it. */
  name: string;
}

export const IT_REGIONS: readonly ItRegion[] = [
  { code: "01", name: "Piemonte" },
  { code: "02", name: "Valle d'Aosta/Vallée d'Aoste" },
  { code: "03", name: "Lombardia" },
  // The addizionale here is set by the autonomous provinces of Trento and
  // Bolzano, each on its own timetable — never one region-wide rate.
  { code: "04", name: "Trentino-Alto Adige/Südtirol" },
  { code: "05", name: "Veneto" },
  { code: "06", name: "Friuli-Venezia Giulia" },
  { code: "07", name: "Liguria" },
  { code: "08", name: "Emilia-Romagna" },
  { code: "09", name: "Toscana" },
  { code: "10", name: "Umbria" },
  { code: "11", name: "Marche" },
  { code: "12", name: "Lazio" },
  { code: "13", name: "Abruzzo" },
  { code: "14", name: "Molise" },
  { code: "15", name: "Campania" },
  { code: "16", name: "Puglia" },
  { code: "17", name: "Basilicata" },
  { code: "18", name: "Calabria" },
  { code: "19", name: "Sicilia" },
  { code: "20", name: "Sardegna" },
];

/** Every code an employee may legitimately carry. */
export const IT_REGION_CODES: readonly string[] = IT_REGIONS.map((region) => region.code);
