/** Offline structural validation against the published CII D16B and UBL 2.1 schemas. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { validateXML, type XMLFileInfo } from "xmllint-wasm";
import { parseEInvoiceXml } from "./parse.ts";
import { EInvoiceRefusal } from "./rules.ts";

interface SchemaManifest { files: Array<{ path: string; sha256: string }> }
let files: Promise<XMLFileInfo[]> | null = null;

function publishedSchemas(): Promise<XMLFileInfo[]> {
  files ??= (async () => {
    const manifest = JSON.parse(await readFile(new URL("./standards/manifest.json", import.meta.url), "utf8")) as SchemaManifest;
    return Promise.all(manifest.files.map(async (entry) => {
      if (!/^(cii|ubl)\/[A-Za-z0-9_./-]+\.xsd$/.test(entry.path) || entry.path.includes("..")) throw new Error("Invalid published e-invoice schema path.");
      const contents = await readFile(new URL(`./standards/${entry.path}`, import.meta.url));
      if (createHash("sha256").update(contents).digest("hex") !== entry.sha256) throw new Error(`Published e-invoice schema digest mismatch: ${entry.path}.`);
      return { fileName: entry.path, contents };
    }));
  })();
  return files;
}

/** Validate locally with no network fetches and return the original, unmodified XML bytes. */
export async function validateEInvoiceXmlSchema(xml: string): Promise<string> {
  const parsed = parseEInvoiceXml(xml);
  const schemaPath = parsed.syntax === "cii" ? "cii/16b/xsd/CrossIndustryInvoice_100pD16B.xsd"
    : `ubl/2.1/xsd/maindoc/UBL-${parsed.isCreditNote ? "CreditNote" : "Invoice"}-2.1.xsd`;
  const published = await publishedSchemas();
  const schema = published.find((file) => file.fileName === schemaPath);
  if (!schema) throw new Error(`The published schema ${schemaPath} is unavailable.`);
  const result = await validateXML({
    xml: { fileName: "invoice.xml", contents: xml },
    schema,
    preload: published.filter((file) => file.fileName !== schemaPath),
    initialMemoryPages: 512,
    maxMemoryPages: 1024,
    modifyArguments: (args) => ["--nonet", ...args],
  });
  if (!result.valid) throw new EInvoiceRefusal([{
    ruleId: "OB-XSD-01", severity: "fatal", term: null,
    message: `The invoice fails the published ${parsed.syntax === "cii" ? "CII D16B" : "UBL 2.1"} schema: ${result.errors.map((error) => error.message).join("; ")}`,
    params: { syntax: parsed.syntax },
  }]);
  return xml;
}
