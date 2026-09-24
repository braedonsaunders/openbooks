/**
 * ISO 3166-2 subdivision codes for lien-waiver (and project-site)
 * jurisdictions.
 *
 * Source: ISO 3166-2 (Online Browsing Platform), subdivision codes as
 * published for the countries below; names are common English short names.
 * Compiled 2026-09-24. Coverage is the set of countries listed in
 * SUBDIVISIONS — a jurisdiction outside that set refuses with a named
 * remedy, and gains support by extending the list (the derived test pins
 * the structure, not the coverage). This registry is deliberately NOT the
 * tax subdivision catalog (pack-scoped) and NOT tax_jurisdictions (per-org
 * tax authorities): a lien attaches under the law of the project's site,
 * whatever the org's tax footprint.
 *
 * Codes are stored canonicalised (uppercase, e.g. US-CA); validation is
 * exact-match against this list, never a format check alone.
 */

export interface SubdivisionEntry {
  /** ISO 3166-1 alpha-2 country. */
  country: string;
  /** Full ISO 3166-2 code, e.g. US-CA. */
  code: string;
  /** Common English short name. */
  name: string;
}

const US: SubdivisionEntry[] = [
  { country: "US", code: "US-AL", name: "Alabama" },
  { country: "US", code: "US-AK", name: "Alaska" },
  { country: "US", code: "US-AS", name: "American Samoa" },
  { country: "US", code: "US-AZ", name: "Arizona" },
  { country: "US", code: "US-AR", name: "Arkansas" },
  { country: "US", code: "US-CA", name: "California" },
  { country: "US", code: "US-CO", name: "Colorado" },
  { country: "US", code: "US-CT", name: "Connecticut" },
  { country: "US", code: "US-DE", name: "Delaware" },
  { country: "US", code: "US-DC", name: "District of Columbia" },
  { country: "US", code: "US-FL", name: "Florida" },
  { country: "US", code: "US-GA", name: "Georgia" },
  { country: "US", code: "US-GU", name: "Guam" },
  { country: "US", code: "US-HI", name: "Hawaii" },
  { country: "US", code: "US-ID", name: "Idaho" },
  { country: "US", code: "US-IL", name: "Illinois" },
  { country: "US", code: "US-IN", name: "Indiana" },
  { country: "US", code: "US-IA", name: "Iowa" },
  { country: "US", code: "US-KS", name: "Kansas" },
  { country: "US", code: "US-KY", name: "Kentucky" },
  { country: "US", code: "US-LA", name: "Louisiana" },
  { country: "US", code: "US-ME", name: "Maine" },
  { country: "US", code: "US-MD", name: "Maryland" },
  { country: "US", code: "US-MA", name: "Massachusetts" },
  { country: "US", code: "US-MI", name: "Michigan" },
  { country: "US", code: "US-MN", name: "Minnesota" },
  { country: "US", code: "US-MS", name: "Mississippi" },
  { country: "US", code: "US-MO", name: "Missouri" },
  { country: "US", code: "US-MT", name: "Montana" },
  { country: "US", code: "US-NE", name: "Nebraska" },
  { country: "US", code: "US-NV", name: "Nevada" },
  { country: "US", code: "US-NH", name: "New Hampshire" },
  { country: "US", code: "US-NJ", name: "New Jersey" },
  { country: "US", code: "US-NM", name: "New Mexico" },
  { country: "US", code: "US-NY", name: "New York" },
  { country: "US", code: "US-NC", name: "North Carolina" },
  { country: "US", code: "US-ND", name: "North Dakota" },
  { country: "US", code: "US-MP", name: "Northern Mariana Islands" },
  { country: "US", code: "US-OH", name: "Ohio" },
  { country: "US", code: "US-OK", name: "Oklahoma" },
  { country: "US", code: "US-OR", name: "Oregon" },
  { country: "US", code: "US-PA", name: "Pennsylvania" },
  { country: "US", code: "US-PR", name: "Puerto Rico" },
  { country: "US", code: "US-RI", name: "Rhode Island" },
  { country: "US", code: "US-SC", name: "South Carolina" },
  { country: "US", code: "US-SD", name: "South Dakota" },
  { country: "US", code: "US-TN", name: "Tennessee" },
  { country: "US", code: "US-TX", name: "Texas" },
  { country: "US", code: "US-UT", name: "Utah" },
  { country: "US", code: "US-VT", name: "Vermont" },
  { country: "US", code: "US-VI", name: "Virgin Islands, U.S." },
  { country: "US", code: "US-VA", name: "Virginia" },
  { country: "US", code: "US-WA", name: "Washington" },
  { country: "US", code: "US-WV", name: "West Virginia" },
  { country: "US", code: "US-WI", name: "Wisconsin" },
  { country: "US", code: "US-WY", name: "Wyoming" },
];

const CA: SubdivisionEntry[] = [
  { country: "CA", code: "CA-AB", name: "Alberta" },
  { country: "CA", code: "CA-BC", name: "British Columbia" },
  { country: "CA", code: "CA-MB", name: "Manitoba" },
  { country: "CA", code: "CA-NB", name: "New Brunswick" },
  { country: "CA", code: "CA-NL", name: "Newfoundland and Labrador" },
  { country: "CA", code: "CA-NS", name: "Nova Scotia" },
  { country: "CA", code: "CA-NT", name: "Northwest Territories" },
  { country: "CA", code: "CA-NU", name: "Nunavut" },
  { country: "CA", code: "CA-ON", name: "Ontario" },
  { country: "CA", code: "CA-PE", name: "Prince Edward Island" },
  { country: "CA", code: "CA-QC", name: "Quebec" },
  { country: "CA", code: "CA-SK", name: "Saskatchewan" },
  { country: "CA", code: "CA-YT", name: "Yukon" },
];

const AU: SubdivisionEntry[] = [
  { country: "AU", code: "AU-ACT", name: "Australian Capital Territory" },
  { country: "AU", code: "AU-NSW", name: "New South Wales" },
  { country: "AU", code: "AU-NT", name: "Northern Territory" },
  { country: "AU", code: "AU-QLD", name: "Queensland" },
  { country: "AU", code: "AU-SA", name: "South Australia" },
  { country: "AU", code: "AU-TAS", name: "Tasmania" },
  { country: "AU", code: "AU-VIC", name: "Victoria" },
  { country: "AU", code: "AU-WA", name: "Western Australia" },
];

const DE: SubdivisionEntry[] = [
  { country: "DE", code: "DE-BB", name: "Brandenburg" },
  { country: "DE", code: "DE-BE", name: "Berlin" },
  { country: "DE", code: "DE-BW", name: "Baden-Wurttemberg" },
  { country: "DE", code: "DE-BY", name: "Bavaria" },
  { country: "DE", code: "DE-HB", name: "Bremen" },
  { country: "DE", code: "DE-HE", name: "Hesse" },
  { country: "DE", code: "DE-HH", name: "Hamburg" },
  { country: "DE", code: "DE-MV", name: "Mecklenburg-Vorpommern" },
  { country: "DE", code: "DE-NI", name: "Lower Saxony" },
  { country: "DE", code: "DE-NW", name: "North Rhine-Westphalia" },
  { country: "DE", code: "DE-RP", name: "Rhineland-Palatinate" },
  { country: "DE", code: "DE-SH", name: "Schleswig-Holstein" },
  { country: "DE", code: "DE-SL", name: "Saarland" },
  { country: "DE", code: "DE-SN", name: "Saxony" },
  { country: "DE", code: "DE-ST", name: "Saxony-Anhalt" },
  { country: "DE", code: "DE-TH", name: "Thuringia" },
];

const FR: SubdivisionEntry[] = [
  { country: "FR", code: "FR-ARA", name: "Auvergne-Rhone-Alpes" },
  { country: "FR", code: "FR-BFC", name: "Bourgogne-Franche-Comte" },
  { country: "FR", code: "FR-BRE", name: "Brittany" },
  { country: "FR", code: "FR-CVL", name: "Centre-Val de Loire" },
  { country: "FR", code: "FR-COR", name: "Corsica" },
  { country: "FR", code: "FR-GES", name: "Grand Est" },
  { country: "FR", code: "FR-HDF", name: "Hauts-de-France" },
  { country: "FR", code: "FR-IDF", name: "Ile-de-France" },
  { country: "FR", code: "FR-NOR", name: "Normandy" },
  { country: "FR", code: "FR-NAQ", name: "Nouvelle-Aquitaine" },
  { country: "FR", code: "FR-OCC", name: "Occitanie" },
  { country: "FR", code: "FR-PDL", name: "Pays de la Loire" },
  { country: "FR", code: "FR-PAC", name: "Provence-Alpes-Cote d'Azur" },
  { country: "FR", code: "FR-GP", name: "Guadeloupe" },
  { country: "FR", code: "FR-MQ", name: "Martinique" },
  { country: "FR", code: "FR-GF", name: "French Guiana" },
  { country: "FR", code: "FR-RE", name: "Reunion" },
  { country: "FR", code: "FR-YT", name: "Mayotte" },
];

const ES: SubdivisionEntry[] = [
  { country: "ES", code: "ES-AN", name: "Andalusia" },
  { country: "ES", code: "ES-AR", name: "Aragon" },
  { country: "ES", code: "ES-AS", name: "Asturias" },
  { country: "ES", code: "ES-CN", name: "Canary Islands" },
  { country: "ES", code: "ES-CB", name: "Cantabria" },
  { country: "ES", code: "ES-CL", name: "Castile and Leon" },
  { country: "ES", code: "ES-CM", name: "Castilla-La Mancha" },
  { country: "ES", code: "ES-CT", name: "Catalonia" },
  { country: "ES", code: "ES-EX", name: "Extremadura" },
  { country: "ES", code: "ES-GA", name: "Galicia" },
  { country: "ES", code: "ES-IB", name: "Balearic Islands" },
  { country: "ES", code: "ES-RI", name: "La Rioja" },
  { country: "ES", code: "ES-MD", name: "Madrid" },
  { country: "ES", code: "ES-MC", name: "Murcia" },
  { country: "ES", code: "ES-NC", name: "Navarre" },
  { country: "ES", code: "ES-PV", name: "Basque Country" },
  { country: "ES", code: "ES-VC", name: "Valencian Community" },
  { country: "ES", code: "ES-CE", name: "Ceuta" },
  { country: "ES", code: "ES-ML", name: "Melilla" },
];

const IT: SubdivisionEntry[] = [
  { country: "IT", code: "IT-ABR", name: "Abruzzo" },
  { country: "IT", code: "IT-AOS", name: "Aosta Valley" },
  { country: "IT", code: "IT-APU", name: "Apulia" },
  { country: "IT", code: "IT-BAS", name: "Basilicata" },
  { country: "IT", code: "IT-CAL", name: "Calabria" },
  { country: "IT", code: "IT-CAM", name: "Campania" },
  { country: "IT", code: "IT-EMR", name: "Emilia-Romagna" },
  { country: "IT", code: "IT-FVG", name: "Friuli-Venezia Giulia" },
  { country: "IT", code: "IT-LAZ", name: "Lazio" },
  { country: "IT", code: "IT-LIG", name: "Liguria" },
  { country: "IT", code: "IT-LOM", name: "Lombardy" },
  { country: "IT", code: "IT-MAR", name: "Marche" },
  { country: "IT", code: "IT-MOL", name: "Molise" },
  { country: "IT", code: "IT-PIE", name: "Piedmont" },
  { country: "IT", code: "IT-SAR", name: "Sardinia" },
  { country: "IT", code: "IT-SIC", name: "Sicily" },
  { country: "IT", code: "IT-TOS", name: "Tuscany" },
  { country: "IT", code: "IT-TAA", name: "Trentino-Alto Adige" },
  { country: "IT", code: "IT-UMB", name: "Umbria" },
  { country: "IT", code: "IT-VEN", name: "Veneto" },
];

const NL: SubdivisionEntry[] = [
  { country: "NL", code: "NL-DR", name: "Drenthe" },
  { country: "NL", code: "NL-FL", name: "Flevoland" },
  { country: "NL", code: "NL-FR", name: "Friesland" },
  { country: "NL", code: "NL-GE", name: "Gelderland" },
  { country: "NL", code: "NL-GR", name: "Groningen" },
  { country: "NL", code: "NL-LI", name: "Limburg" },
  { country: "NL", code: "NL-NB", name: "North Brabant" },
  { country: "NL", code: "NL-NH", name: "North Holland" },
  { country: "NL", code: "NL-OV", name: "Overijssel" },
  { country: "NL", code: "NL-UT", name: "Utrecht" },
  { country: "NL", code: "NL-ZE", name: "Zeeland" },
  { country: "NL", code: "NL-ZH", name: "South Holland" },
];

const BE: SubdivisionEntry[] = [
  { country: "BE", code: "BE-BRU", name: "Brussels-Capital Region" },
  { country: "BE", code: "BE-VLG", name: "Flanders" },
  { country: "BE", code: "BE-WAL", name: "Wallonia" },
];

const CH: SubdivisionEntry[] = [
  { country: "CH", code: "CH-AG", name: "Aargau" },
  { country: "CH", code: "CH-AI", name: "Appenzell Innerrhoden" },
  { country: "CH", code: "CH-AR", name: "Appenzell Ausserrhoden" },
  { country: "CH", code: "CH-BE", name: "Bern" },
  { country: "CH", code: "CH-BL", name: "Basel-Landschaft" },
  { country: "CH", code: "CH-BS", name: "Basel-Stadt" },
  { country: "CH", code: "CH-FR", name: "Fribourg" },
  { country: "CH", code: "CH-GE", name: "Geneva" },
  { country: "CH", code: "CH-GL", name: "Glarus" },
  { country: "CH", code: "CH-GR", name: "Grisons" },
  { country: "CH", code: "CH-JU", name: "Jura" },
  { country: "CH", code: "CH-LU", name: "Lucerne" },
  { country: "CH", code: "CH-NE", name: "Neuchatel" },
  { country: "CH", code: "CH-NW", name: "Nidwalden" },
  { country: "CH", code: "CH-OW", name: "Obwalden" },
  { country: "CH", code: "CH-SG", name: "St. Gallen" },
  { country: "CH", code: "CH-SH", name: "Schaffhausen" },
  { country: "CH", code: "CH-SZ", name: "Schwyz" },
  { country: "CH", code: "CH-SO", name: "Solothurn" },
  { country: "CH", code: "CH-TG", name: "Thurgau" },
  { country: "CH", code: "CH-TI", name: "Ticino" },
  { country: "CH", code: "CH-UR", name: "Uri" },
  { country: "CH", code: "CH-VS", name: "Valais" },
  { country: "CH", code: "CH-VD", name: "Vaud" },
  { country: "CH", code: "CH-ZG", name: "Zug" },
  { country: "CH", code: "CH-ZH", name: "Zurich" },
];

const AT: SubdivisionEntry[] = [
  { country: "AT", code: "AT-B", name: "Burgenland" },
  { country: "AT", code: "AT-K", name: "Carinthia" },
  { country: "AT", code: "AT-N", name: "Lower Austria" },
  { country: "AT", code: "AT-O", name: "Upper Austria" },
  { country: "AT", code: "AT-S", name: "Salzburg" },
  { country: "AT", code: "AT-ST", name: "Styria" },
  { country: "AT", code: "AT-T", name: "Tyrol" },
  { country: "AT", code: "AT-V", name: "Vorarlberg" },
  { country: "AT", code: "AT-W", name: "Vienna" },
];

const MX: SubdivisionEntry[] = [
  { country: "MX", code: "MX-AGU", name: "Aguascalientes" },
  { country: "MX", code: "MX-BCN", name: "Baja California" },
  { country: "MX", code: "MX-BCS", name: "Baja California Sur" },
  { country: "MX", code: "MX-CAM", name: "Campeche" },
  { country: "MX", code: "MX-CHP", name: "Chiapas" },
  { country: "MX", code: "MX-CHH", name: "Chihuahua" },
  { country: "MX", code: "MX-CMX", name: "Mexico City" },
  { country: "MX", code: "MX-COA", name: "Coahuila" },
  { country: "MX", code: "MX-COL", name: "Colima" },
  { country: "MX", code: "MX-DUR", name: "Durango" },
  { country: "MX", code: "MX-GRO", name: "Guerrero" },
  { country: "MX", code: "MX-GUA", name: "Guanajuato" },
  { country: "MX", code: "MX-HID", name: "Hidalgo" },
  { country: "MX", code: "MX-JAL", name: "Jalisco" },
  { country: "MX", code: "MX-MEX", name: "State of Mexico" },
  { country: "MX", code: "MX-MIC", name: "Michoacan" },
  { country: "MX", code: "MX-MOR", name: "Morelos" },
  { country: "MX", code: "MX-NAY", name: "Nayarit" },
  { country: "MX", code: "MX-NLE", name: "Nuevo Leon" },
  { country: "MX", code: "MX-OAX", name: "Oaxaca" },
  { country: "MX", code: "MX-PUE", name: "Puebla" },
  { country: "MX", code: "MX-QUE", name: "Queretaro" },
  { country: "MX", code: "MX-ROO", name: "Quintana Roo" },
  { country: "MX", code: "MX-SIN", name: "Sinaloa" },
  { country: "MX", code: "MX-SLP", name: "San Luis Potosi" },
  { country: "MX", code: "MX-SON", name: "Sonora" },
  { country: "MX", code: "MX-TAB", name: "Tabasco" },
  { country: "MX", code: "MX-TAM", name: "Tamaulipas" },
  { country: "MX", code: "MX-TLA", name: "Tlaxcala" },
  { country: "MX", code: "MX-VER", name: "Veracruz" },
  { country: "MX", code: "MX-YUC", name: "Yucatan" },
  { country: "MX", code: "MX-ZAC", name: "Zacatecas" },
];

const BR: SubdivisionEntry[] = [
  { country: "BR", code: "BR-AC", name: "Acre" },
  { country: "BR", code: "BR-AL", name: "Alagoas" },
  { country: "BR", code: "BR-AP", name: "Amapa" },
  { country: "BR", code: "BR-AM", name: "Amazonas" },
  { country: "BR", code: "BR-BA", name: "Bahia" },
  { country: "BR", code: "BR-CE", name: "Ceara" },
  { country: "BR", code: "BR-DF", name: "Distrito Federal" },
  { country: "BR", code: "BR-ES", name: "Espirito Santo" },
  { country: "BR", code: "BR-GO", name: "Goias" },
  { country: "BR", code: "BR-MA", name: "Maranhao" },
  { country: "BR", code: "BR-MT", name: "Mato Grosso" },
  { country: "BR", code: "BR-MS", name: "Mato Grosso do Sul" },
  { country: "BR", code: "BR-MG", name: "Minas Gerais" },
  { country: "BR", code: "BR-PA", name: "Para" },
  { country: "BR", code: "BR-PB", name: "Paraiba" },
  { country: "BR", code: "BR-PR", name: "Parana" },
  { country: "BR", code: "BR-PE", name: "Pernambuco" },
  { country: "BR", code: "BR-PI", name: "Piaui" },
  { country: "BR", code: "BR-RJ", name: "Rio de Janeiro" },
  { country: "BR", code: "BR-RN", name: "Rio Grande do Norte" },
  { country: "BR", code: "BR-RS", name: "Rio Grande do Sul" },
  { country: "BR", code: "BR-RO", name: "Rondonia" },
  { country: "BR", code: "BR-RR", name: "Roraima" },
  { country: "BR", code: "BR-SC", name: "Santa Catarina" },
  { country: "BR", code: "BR-SP", name: "Sao Paulo" },
  { country: "BR", code: "BR-SE", name: "Sergipe" },
  { country: "BR", code: "BR-TO", name: "Tocantins" },
];

const GB: SubdivisionEntry[] = [
  { country: "GB", code: "GB-ENG", name: "England" },
  { country: "GB", code: "GB-SCT", name: "Scotland" },
  { country: "GB", code: "GB-WLS", name: "Wales" },
  { country: "GB", code: "GB-NIR", name: "Northern Ireland" },
];

/** Every subdivision the registry recognises, in ISO 3166-2 code order. */
export const SUBDIVISIONS: readonly SubdivisionEntry[] = [
  ...US, ...CA, ...AU, ...DE, ...FR, ...ES, ...IT, ...NL, ...BE, ...CH, ...AT, ...MX, ...BR, ...GB,
];

const KNOWN_CODES = new Set(SUBDIVISIONS.map((entry) => entry.code));

/** Exact-match membership: never a format check alone. */
export function isKnownSubdivision(code: string): boolean {
  return KNOWN_CODES.has(code);
}

/**
 * Canonicalise free input to a registry code, or null when it is not one.
 * Trims and uppercases first (so `us-ca` files as US-CA); anything else —
 * a bare state name, a malformed shape, a subdivision outside the registry
 * — is not a jurisdiction and must be refused by name at the call site.
 */
export function normalizeSubdivisionCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const canonical = value.trim().toUpperCase();
  if (!/^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(canonical)) return null;
  return KNOWN_CODES.has(canonical) ? canonical : null;
}

/** Display name for a registry code, for refusal messages and pickers. */
export function subdivisionName(code: string): string | null {
  return SUBDIVISIONS.find((entry) => entry.code === code)?.name ?? null;
}
