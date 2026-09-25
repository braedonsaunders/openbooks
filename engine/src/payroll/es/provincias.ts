/**
 * The AEAT province codes for the Modelo 190 perceptor record.
 *
 * Authority: BOE Orden EHA/3127/2009, Modelo 190 registro tipo 2,
 * posiciones 76–77 — the two-digit code of the perceptor's DOMICILE
 * province (provincia del domicilio del perceptor), not the workplace.
 * The codes are the Instituto Nacional de Estadística province codes the
 * AEAT diseños lógicos reuse (01–50 peninsular and insular provinces in
 * alphabetical order, 51 Ceuta, 52 Melilla).
 *
 * This table is the ONLY place that maps codes to names: ./certificates.ts
 * builds the domicilio field's closed choice list from it and ./yearend.ts
 * renders the slip header from it, so the three can never drift apart.
 */
export interface EsProvincia {
  /** The two-digit code filed on the 190 (positions 76–77). */
  readonly code: string;
  /** The province's Spanish proper noun. */
  readonly name: string;
}

export const ES_PROVINCIAS: readonly EsProvincia[] = [
  { code: "01", name: "Araba/Álava" },
  { code: "02", name: "Albacete" },
  { code: "03", name: "Alicante/Alacant" },
  { code: "04", name: "Almería" },
  { code: "05", name: "Ávila" },
  { code: "06", name: "Badajoz" },
  { code: "07", name: "Illes Balears" },
  { code: "08", name: "Barcelona" },
  { code: "09", name: "Burgos" },
  { code: "10", name: "Cáceres" },
  { code: "11", name: "Cádiz" },
  { code: "12", name: "Castellón/Castelló" },
  { code: "13", name: "Ciudad Real" },
  { code: "14", name: "Córdoba" },
  { code: "15", name: "A Coruña" },
  { code: "16", name: "Cuenca" },
  { code: "17", name: "Girona" },
  { code: "18", name: "Granada" },
  { code: "19", name: "Guadalajara" },
  { code: "20", name: "Gipuzkoa" },
  { code: "21", name: "Huelva" },
  { code: "22", name: "Huesca" },
  { code: "23", name: "Jaén" },
  { code: "24", name: "León" },
  { code: "25", name: "Lleida" },
  { code: "26", name: "La Rioja" },
  { code: "27", name: "Lugo" },
  { code: "28", name: "Madrid" },
  { code: "29", name: "Málaga" },
  { code: "30", name: "Murcia" },
  { code: "31", name: "Navarra" },
  { code: "32", name: "Ourense" },
  { code: "33", name: "Asturias" },
  { code: "34", name: "Palencia" },
  { code: "35", name: "Las Palmas" },
  { code: "36", name: "Pontevedra" },
  { code: "37", name: "Salamanca" },
  { code: "38", name: "Santa Cruz de Tenerife" },
  { code: "39", name: "Cantabria" },
  { code: "40", name: "Segovia" },
  { code: "41", name: "Sevilla" },
  { code: "42", name: "Soria" },
  { code: "43", name: "Tarragona" },
  { code: "44", name: "Teruel" },
  { code: "45", name: "Toledo" },
  { code: "46", name: "Valencia/València" },
  { code: "47", name: "Valladolid" },
  { code: "48", name: "Bizkaia" },
  { code: "49", name: "Zamora" },
  { code: "50", name: "Zaragoza" },
  { code: "51", name: "Ceuta" },
  { code: "52", name: "Melilla" },
];

/** The closed answer set for the domicile-province fact and field. */
export const ES_PROVINCIA_CODES: readonly string[] = ES_PROVINCIAS.map(
  (provincia) => provincia.code,
);

/** The filed code's display name, or null for a code the table never issued. */
export function esProvinciaName(code: string): string | null {
  return ES_PROVINCIAS.find((provincia) => provincia.code === code)?.name ?? null;
}
