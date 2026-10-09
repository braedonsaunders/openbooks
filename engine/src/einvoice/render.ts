// Portions derived from OpenConstructionERP (https://github.com/datadrivenconstruction/OpenConstructionERP),
// Copyright (C) 2026 Artem Boiko / DataDrivenConstruction, licensed under AGPL-3.0-or-later.

/**
 * Render an EN 16931 invoice in the syntax its profile declares.
 *
 * Strict rendering (the default) evaluates native model rules and refuses
 * fatal findings. Issuance additionally validates the serialized bytes
 * against the published syntax schema. Non-strict rendering is intended
 * for previews and diagnostics.
 */

import { renderCii } from "./cii.ts";
import type { EInvoice } from "./model.ts";
import { getEInvoiceProfile } from "./profiles.ts";
import { EInvoiceRefusal, fatalFindings, validateEInvoice } from "./rules.ts";
import { renderUbl } from "./ubl.ts";

export interface RenderedEInvoice {
  xml: string;
  fileName: string;
  mediaType: "application/xml";
}

function fileToken(value: string): string {
  return value.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 120);
}

export function renderEInvoiceXml(inv: EInvoice, options: { strict?: boolean } = {}): RenderedEInvoice {
  const strict = options.strict ?? true;
  if (strict) {
    const findings = validateEInvoice(inv);
    if (fatalFindings(findings).length > 0) throw new EInvoiceRefusal(findings);
  }
  const profile = getEInvoiceProfile(inv.profile);
  if (!profile) throw new Error(`"${String(inv.profile)}" is not a supported e-invoice profile`);
  const xml = profile.syntax === "cii" ? renderCii(inv, profile) : renderUbl(inv, profile);
  const fileName = profile.hybrid?.attachmentFileName ?? `${fileToken(inv.number) || "einvoice"}.xml`;
  return { xml, fileName, mediaType: "application/xml" };
}
