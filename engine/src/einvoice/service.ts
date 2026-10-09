/** Native invoice mapping and immutable issuance; callers supply their resolved entity scope. */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, withOrgTransaction, type SqlExecutor } from '../platform/db.ts';
import { actorAllowedSubsidiaryIds } from '../organization/actor-subsidiaries.ts';
import { actorHasPermission } from '../organization/actor-permissions.ts';
import { lockAndCheckOrgFeature } from '../organization/org-feature-lock.ts';
import { ScopeNotFoundError, subsidiaryVisibleFilter } from '../organization/subsidiary-scope.ts';
import { add, cmp, isZero, neg, sum } from '../money/money.ts';
import { canonicalDecimal } from '../money/exact-decimal.ts';
import { computeEInvoiceAmounts, type EInvoice, type EInvoiceLine, type VatCategory } from './model.ts';
import { hasAtMostDecimals } from './decimal.ts';
import { unitCode, isVatCategory } from './codes.ts';
import { getEInvoiceProfile, type EInvoiceProfileKey } from './profiles.ts';
import { renderEInvoiceXml } from './render.ts';
import { validateEInvoice } from './rules.ts';
import { embedFacturX } from './facturx.ts';
import { validateEInvoiceXmlSchema } from './schema-validation.ts';

export class EInvoiceConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = 'EInvoiceConfigurationError'; }
}
export interface EInvoiceActor { orgId: string; actorId: string; allowedSubsidiaryIds: ReadonlySet<string> | null }
export interface EInvoiceIssueOptions { profile?: EInvoiceProfileKey; buyerReference?: string | null }
export interface IssuedEInvoice { id: string; fileName: string; mediaType: 'application/xml' | 'application/pdf'; content: Uint8Array; sha256: string }
type Row = Record<string, unknown>;
function text(value: unknown): string | null { return value == null ? null : String(value); }
function required(value: unknown, name: string): string {
  if (value == null || String(value).trim() === '') throw new EInvoiceConfigurationError(`${name} is missing. Complete the record in Setup before issuing this invoice.`);
  return String(value);
}
function amount(value: unknown, name: string): string {
  const result = canonicalDecimal(value, 4);
  if (result === null) throw new EInvoiceConfigurationError(`${name} must be an exact decimal.`);
  return result;
}

/** Accounting currency evidence comes from the original posting, never a current FX policy. */
async function singaporeAccountingAmounts(executor: SqlExecutor, actor: EInvoiceActor, doc: Row, entity: Row, components: Row[], invoice: EInvoice): Promise<void> {
  if (invoice.currency === 'SGD') return;
  if (entity.base_currency !== 'SGD' || !doc.posted_entry_id) throw new EInvoiceConfigurationError('A foreign-currency Singapore invoice requires its original posting in an SGD functional-currency legal entity.');
  const entries = (await executor.execute<Row>(sql`
    select e.id from journal_entries e join accounting_books b on b.id=e.book_id and b.org_id=e.org_id
    where e.org_id=${actor.orgId} and e.id=${doc.posted_entry_id} and e.source_document_id=${doc.id}
      and e.subsidiary_id=${doc.subsidiary_id} and e.origin='document' and e.status='posted'
      and e.reverses_entry_id is null and b.is_primary for share of e, b`)).rows;
  if (entries.length !== 1) throw new EInvoiceConfigurationError('The original primary-book posting is unavailable. Restore its native posting evidence before issuing the e-invoice.');
  const posted = (await executor.execute<Row>(sql`
    select l.*, a.type as account_type from journal_lines l join accounts a on a.id=l.account_id and a.org_id=l.org_id
    where l.org_id=${actor.orgId} and l.entry_id=${doc.posted_entry_id} order by l.line_number for share of l`)).rows;
  if (!posted.length || posted.some(l => l.subsidiary_id !== doc.subsidiary_id || l.currency !== invoice.currency)
    || !isZero(sum(posted.map(l => amount(l.amount, 'Posted SGD amount'))))) throw new EInvoiceConfigurationError('The original posting has ambiguous legal-entity or currency evidence. A Singapore e-invoice requires a balanced posting for its invoicing entity.');
  const control = posted.filter(l => l.is_open_item === true && l.account_type === 'asset_receivable' && l.party_id === doc.party_id && !l.tax_code_id && !l.contributor_kind);
  if (control.length !== 1 || posted.filter(l => l.is_open_item === true).length !== 1) throw new EInvoiceConfigurationError('The original posting must identify exactly one customer receivable control amount for the Singapore e-invoice.');
  const direction = doc.kind === 'customer_credit' ? neg : (value: string) => value;
  if (cmp(direction(amount(control[0]!.txn_amount, 'Posted receivable transaction amount')), invoice.totals.taxInclusive)) throw new EInvoiceConfigurationError('The original receivable does not match the invoice total. Use a governed correction before issuing the e-invoice.');
  const expected = new Map<string, string>();
  for (const c of components) {
    if (c.calculation_type !== 'standard' || isZero(amount(c.tax_amount, 'Posted GST component'))) continue;
    const key = `${required(c.tax_code_id, 'Posted GST tax code')}|${required(c.collected_account_id, 'Posted GST liability account')}`;
    expected.set(key, add(expected.get(key) ?? '0', amount(c.tax_amount, 'Posted GST component')));
  }
  const taxLines = posted.filter(l => l.tax_code_id != null);
  const actual = new Map<string, string>();
  for (const l of taxLines) {
    const key = `${l.tax_code_id}|${l.account_id}`;
    if (!expected.has(key) || l.contributor_kind || l.account_type !== 'liability_current_other') throw new EInvoiceConfigurationError('The original posting cannot unambiguously identify the GST liability. Restore the posted component and liability evidence before issuing the e-invoice.');
    actual.set(key, add(actual.get(key) ?? '0', neg(direction(amount(l.txn_amount, 'Posted GST transaction amount')))));
  }
  if (expected.size !== actual.size || [...expected].some(([key, value]) => cmp(value, actual.get(key) ?? '0'))) throw new EInvoiceConfigurationError('The original GST liability does not reconcile to the posted tax components. Use a governed correction before issuing the e-invoice.');
  const inclusive = direction(amount(control[0]!.amount, 'Posted SGD receivable'));
  const tax = neg(direction(sum(taxLines.map(l => amount(l.amount, 'Posted SGD GST liability')))));
  if (!hasAtMostDecimals(inclusive, 2) || !hasAtMostDecimals(tax, 2)) throw new EInvoiceConfigurationError('The original SGD posting has precision unsupported by the Singapore e-invoice totals. Correct the posting through the native workflow before issuance.');
  invoice.taxCurrency = 'SGD';
  invoice.taxTotalInTaxCurrency = tax;
  invoice.accountingCurrencyTotals = { taxInclusive: inclusive, taxExclusive: add(inclusive, neg(tax)) };
}

/** Map posted values without guessing tax categories, electronic addresses or identifiers. */
export async function loadNativeEInvoice(executor: SqlExecutor, actor: EInvoiceActor, id: string, options: EInvoiceIssueOptions = {}): Promise<{ invoice: EInvoice; revision: string }> {
  const doc = (await executor.execute<Row>(sql`
    select d.*, d.document_date::text as invoice_date, d.due_date::text as invoice_due, d.revision_seq::text as revision
      from documents d where d.org_id = ${actor.orgId} and d.id = ${id}
      and d.kind in ('customer_invoice','customer_credit') ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, actor.allowedSubsidiaryIds)} for share`)).rows[0];
  if (!doc) throw new ScopeNotFoundError();
  if (doc.status !== 'posted') throw new EInvoiceConfigurationError('Post the invoice or credit note before issuing its e-invoice.');
  const entity = (await executor.execute<Row>(sql`select * from subsidiaries where org_id = ${actor.orgId} and id = ${doc.subsidiary_id} for share`)).rows[0];
  const settings = (await executor.execute<Row>(sql`select * from einvoice_settings where org_id = ${actor.orgId} and subsidiary_id = ${doc.subsidiary_id} for share`)).rows[0];
  if (!entity || !settings) throw new EInvoiceConfigurationError('Configure the invoicing legal entity under Setup → E-invoice seller settings.');
  const buyer = (await executor.execute<Row>(sql`
    select p.display_name, p.legal_name, p.email, p.phone, c.* from parties p
    join customer_roles c on c.org_id = p.org_id and c.party_id = p.id
    where p.org_id = ${actor.orgId} and p.id = ${doc.party_id} for share of p, c`)).rows[0];
  if (!buyer) throw new EInvoiceConfigurationError('The invoice needs a customer with a native customer role.');
  const profileKey = required(options.profile ?? buyer.einvoice_profile ?? settings.default_profile, 'E-invoice profile');
  const profile = getEInvoiceProfile(profileKey);
  if (!profile) throw new EInvoiceConfigurationError('Choose a supported e-invoice profile in Setup.');
  const addresses = (await executor.execute<Row>(sql`
    select * from addresses where org_id = ${actor.orgId} and party_id = ${doc.party_id} and is_default_billing for share`)).rows;
  if (addresses.length !== 1) throw new EInvoiceConfigurationError('Set exactly one default billing address on the customer before issuing an e-invoice.');
  const address = addresses[0]!;
  const taxIdScheme = profile.taxSchemeId === 'GST' ? (profile.ruleSets.includes('aunz') && address.country === 'AU' ? 'abn' : 'gst') : (address.country === 'GB' ? 'hmrc' : 'vies');
  const vatIds = (await executor.execute<{ value: string }>(sql`
    select value from party_tax_ids where org_id = ${actor.orgId} and party_id = ${doc.party_id}
      and scheme = ${taxIdScheme} and is_active for share`)).rows;
  if (vatIds.length > 1) throw new EInvoiceConfigurationError('The customer has multiple active identifiers for this tax scheme. Retire the identifier that does not apply to this invoice.');
  const registrations = (await executor.execute<{ registration_number: string }>(sql`
    select r.registration_number from tax_registrations r join tax_jurisdictions j on j.id = r.jurisdiction_id and j.org_id = r.org_id
    where r.org_id = ${actor.orgId} and r.subsidiary_id = ${doc.subsidiary_id} and r.is_active and j.tax_type = ${profile.taxSchemeId === 'GST' ? 'gst' : 'vat'}
      and j.country = ${entity.country} and r.effective_from <= ${doc.invoice_date}::date
      and (r.effective_to is null or r.effective_to >= ${doc.invoice_date}::date) for share of r`)).rows;
  if (registrations.length > 1) throw new EInvoiceConfigurationError('Multiple tax registrations cover this invoice. End the overlapping registration in Setup.');
  const currency = required(doc.currency, 'Invoice currency');
  const currencyRow = (await executor.execute<{ minor_units: number }>(sql`select minor_units from currencies where code = ${currency}`)).rows[0];
  if (!currencyRow) throw new EInvoiceConfigurationError('The invoice currency is not registered.');
  if (currencyRow.minor_units > 2) throw new EInvoiceConfigurationError('EN 16931 allows at most two decimals for invoice totals. This currency requires more precision; issue a supported currency invoice through the native billing workflow.');
  const rows = (await executor.execute<Row>(sql`
    select l.*, i.name as item_name, i.code as item_code from document_lines l
    left join items i on i.id = l.item_id and i.org_id = l.org_id
    where l.org_id = ${actor.orgId} and l.document_id = ${id} order by l.line_number`)).rows;
  const components = (await executor.execute<Row>(sql`
    select c.*, t.einvoice_category, t.einvoice_effective_from::text as einvoice_effective_from, t.einvoice_exemption_reason_code, t.einvoice_exemption_reason
    from document_line_tax_components c join tax_codes t on t.id = c.tax_code_id and t.org_id = c.org_id
    join document_lines l on l.id = c.document_line_id and l.org_id = c.org_id
    where c.org_id = ${actor.orgId} and l.document_id = ${id}`)).rows;
  const lines: EInvoiceLine[] = [];
  const statedTax: Array<{ category: VatCategory; rate: string; taxAmount: string }> = [];
  const exemptions: Array<{ category: VatCategory; reason: string | null; reasonCode: string | null }> = [];
  for (const row of rows) {
    if (row.subsidiary_id && row.subsidiary_id !== doc.subsidiary_id) throw new EInvoiceConfigurationError(`Line ${row.line_number} belongs to another legal entity. Issue separate native invoices for each invoicing entity.`);
    const taxes = components.filter(c => c.document_line_id === row.id);
    if (taxes.length > 1 || taxes.some(c => c.calculation_type === 'withholding' || c.collected_by === 'marketplace')) throw new EInvoiceConfigurationError(`Line ${row.line_number} has a tax combination that cannot be represented as one e-invoice tax category.`);
    const tax = taxes[0];
    if (!tax && (row.tax_code_id || row.tax_group_id || !isZero(amount(row.tax_amount, 'Line VAT')))) throw new EInvoiceConfigurationError(`Line ${row.line_number} lacks posted tax component evidence. Correct the invoice through the native correction workflow.`);
    if (tax && (!tax.einvoice_effective_from || String(tax.einvoice_effective_from) > String(doc.invoice_date))) throw new EInvoiceConfigurationError(`The e-invoice VAT policy on line ${row.line_number} does not cover this invoice date. Record the applicable effective date and statutory category in Setup.`);
    const categoryText = required(tax?.einvoice_category ?? settings.untaxed_line_category, `VAT category on line ${row.line_number}`);
    if (!isVatCategory(categoryText)) throw new EInvoiceConfigurationError('Choose a supported EN 16931 VAT category on the tax code.');
    const rate = tax ? amount(tax.rate_percent, 'Posted VAT rate') : '0';
    const netAmount = amount(row.amount, 'Line net amount');
    if (!hasAtMostDecimals(netAmount, currencyRow.minor_units) || !hasAtMostDecimals(amount(row.tax_amount, 'Line tax amount'), currencyRow.minor_units)) throw new EInvoiceConfigurationError(`Line ${row.line_number} has posted precision unsupported by this e-invoice currency. Correct the invoice through the native workflow before issuance.`);
    const price = canonicalDecimal(row.unit_price, 8);
    const quantity = canonicalDecimal(row.quantity, 8);
    if (price === null || quantity === null) throw new EInvoiceConfigurationError('The invoice line needs an exact price and quantity.');
    // EN 16931 prices are nonnegative; equivalent signed quantity preserves a posted discount exactly.
    const writtenPrice = price.startsWith('-') ? price.slice(1) : price;
    const writtenQuantity = price.startsWith('-') ? (quantity.startsWith('-') ? quantity.slice(1) : `-${quantity}`) : quantity;
    const lineUnit = unitCode(text(row.unit) ?? (!row.item_id && cmp(quantity,'1') === 0 ? 'C62' : ''));
    if (!lineUnit) throw new EInvoiceConfigurationError(`Set a supported invoice unit on line ${row.line_number}.`);
    lines.push({ id: String(row.line_number), name: required(row.item_name ?? row.description, `Item name on line ${row.line_number}`), description: text(row.description), sellerItemId: text(row.item_code), quantity: writtenQuantity, unitCode: lineUnit, netPrice: writtenPrice, netAmount, vatCategory: categoryText, vatRate: rate });
    statedTax.push({ category: categoryText, rate, taxAmount: tax && tax.calculation_type === 'standard' ? amount(tax.tax_amount, 'Posted VAT amount') : '0' });
    exemptions.push({ category: categoryText, reason: text(tax?.einvoice_exemption_reason ?? settings.untaxed_exemption_reason), reasonCode: text(tax?.einvoice_exemption_reason_code ?? settings.untaxed_exemption_reason_code) });
  }
  const amounts = computeEInvoiceAmounts({ lines, allowanceCharges: [], currencyDecimals: currencyRow.minor_units, statedTax, exemptions });
  if (cmp(amounts.totals.taxExclusive, amount(doc.subtotal, 'Invoice subtotal')) || cmp(amounts.totals.tax, amount(doc.tax_total, 'Invoice VAT')) || cmp(amounts.totals.taxInclusive, amount(doc.total, 'Invoice total'))) throw new EInvoiceConfigurationError('E-invoice totals do not match the posted invoice. Use a governed correction to reconcile the invoice before issuance.');
  const precedingInvoices = (await executor.execute<{ number: string; date: string }>(sql`select d.document_number as number, d.document_date::text as date from document_links l join documents d on d.id = l.to_document_id and d.org_id = l.org_id where l.org_id = ${actor.orgId} and l.from_document_id = ${id} and l.link_type = 'corrects' order by d.document_date, d.id`)).rows.map(row => ({ number: row.number, issueDate: row.date }));
  const invoice: EInvoice = {
    profile: profile.key, number: required(doc.document_number, 'Invoice number'), typeCode: doc.kind === 'customer_credit' ? '381' : '380', issueDate: String(doc.invoice_date), dueDate: text(doc.invoice_due), currency, currencyDecimals: currencyRow.minor_units,
    uuid: String(doc.id), buyerReference: options.buyerReference !== undefined ? options.buyerReference : text(doc.reference_number) ?? text(buyer.einvoice_buyer_reference), precedingInvoices, notes: doc.memo ? [String(doc.memo)] : [],
    seller: { name: required(entity.legal_name ?? entity.name, 'Seller name'), address: { line1: text(settings.address_line1), line2: text(settings.address_line2), city: text(settings.city), postcode: text(settings.postcode), subdivision: text(settings.subdivision), countryCode: required(entity.country, 'Seller country') }, vatId: registrations[0]?.registration_number ?? null, taxRegistrationId: text(settings.tax_number), tradingName: text(settings.trading_name), legalRegistration: settings.legal_registration_id ? { id: String(settings.legal_registration_id), schemeId: text(settings.legal_registration_scheme) } : null, electronicAddress: settings.electronic_address ? { id: String(settings.electronic_address), schemeId: required(settings.electronic_address_scheme, 'Seller electronic address scheme') } : null, contact: { name: text(settings.contact_name), phone: text(settings.contact_phone), email: text(settings.contact_email) } },
    buyer: { name: required(buyer.legal_name ?? buyer.display_name, 'Buyer name'), address: { line1: text(address.line1), line2: text(address.line2), city: text(address.city), postcode: text(address.postal_code), subdivision: text(address.region), countryCode: required(address.country, 'Buyer country') }, vatId: vatIds[0]?.value ?? null, legalRegistration: buyer.einvoice_legal_registration_id ? { id: String(buyer.einvoice_legal_registration_id), schemeId: text(buyer.einvoice_legal_registration_scheme) } : null, electronicAddress: buyer.einvoice_address ? { id: String(buyer.einvoice_address), schemeId: required(buyer.einvoice_address_scheme, 'Buyer electronic address scheme') } : null },
    payment: { meansCode: required(settings.payment_means_code, 'Payment means'), creditTransfer: settings.payee_account_id ? { accountId: String(settings.payee_account_id), accountName: text(settings.payee_account_name), providerId: text(settings.payee_bic) } : null, remittanceInformation: String(doc.document_number) },
    lines, allowanceCharges: [], ...amounts,
  };
  // Explicitly configured legal identities also identify the business under the national profiles.
  invoice.seller.identifier = invoice.seller.legalRegistration ? { ...invoice.seller.legalRegistration } : null;
  invoice.buyer.identifier = invoice.buyer.legalRegistration ? { ...invoice.buyer.legalRegistration } : null;
  if (profile.ruleSets.includes('sg')) await singaporeAccountingAmounts(executor, actor, doc, entity, components, invoice);
  return { invoice, revision: String(doc.revision) };
}

/** Issue once per posted document/profile; retries return the same archived bytes. */
export async function issueNativeEInvoice(actor: EInvoiceActor, documentId: string, options: EInvoiceIssueOptions, renderPdf: (invoice: EInvoice) => Promise<Uint8Array>): Promise<IssuedEInvoice> {
  return withOrgTransaction(actor.orgId, async () => {
    const tx = db;
    if (!(await actorHasPermission(tx, actor.orgId, actor.actorId, 'documents.manage'))) throw new ScopeNotFoundError();
    const authorizedScope = await actorAllowedSubsidiaryIds(tx, actor.orgId, actor.actorId);
    const effectiveScope = authorizedScope === null ? actor.allowedSubsidiaryIds : actor.allowedSubsidiaryIds === null ? authorizedScope : new Set([...authorizedScope].filter(id => actor.allowedSubsidiaryIds!.has(id)));
    actor = { ...actor, allowedSubsidiaryIds: effectiveScope };
    if (!(await lockAndCheckOrgFeature(tx, actor.orgId, 'einvoicing'))) throw new ScopeNotFoundError();
    const document = (await tx.execute<Row>(sql`select d.id from documents d where d.id = ${documentId} and d.org_id = ${actor.orgId} ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, actor.allowedSubsidiaryIds)} for update`)).rows[0];
    if (!document) throw new ScopeNotFoundError();
    if (options.profile) {
      const archived = (await tx.execute<Row>(sql`select * from einvoice_documents where org_id = ${actor.orgId} and document_id = ${documentId} and profile = ${options.profile} order by issued_at limit 1`)).rows[0];
      if (archived) return { id: String(archived.id), fileName: String(archived.file_name), mediaType: archived.media_type as IssuedEInvoice['mediaType'], content: new Uint8Array(archived.content as Uint8Array), sha256: String(archived.content_sha256) };
    }
    const { invoice, revision } = await loadNativeEInvoice(tx, actor, documentId, options);
    const existing = (await tx.execute<Row>(sql`select * from einvoice_documents where org_id = ${actor.orgId} and document_id = ${documentId} and profile = ${invoice.profile} order by issued_at limit 1`)).rows[0];
    if (existing) return { id: String(existing.id), fileName: String(existing.file_name), mediaType: existing.media_type as IssuedEInvoice['mediaType'], content: new Uint8Array(existing.content as Uint8Array), sha256: String(existing.content_sha256) };
    const rendered = renderEInvoiceXml(invoice);
    await validateEInvoiceXmlSchema(rendered.xml);
    const xml = Buffer.from(rendered.xml, 'utf8');
    const content = invoice.profile === 'facturx' ? await embedFacturX(await renderPdf(invoice), rendered.xml, { title: invoice.number, author: invoice.seller.name, createdAt: new Date(`${invoice.issueDate}T00:00:00Z`), conformanceLevel: 'EN 16931' }) : xml;
    const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const sha256 = digest(content);
    const fileName = invoice.profile === 'facturx' ? rendered.fileName.replace(/\.xml$/, '.pdf') : rendered.fileName;
    const mediaType = invoice.profile === 'facturx' ? 'application/pdf' : 'application/xml';
    const issued = (await tx.execute<{ id: string }>(sql`
      insert into einvoice_documents(org_id,document_id,profile,type_code,buyer_reference,file_name,media_type,content,content_sha256,xml_sha256,document_revision,findings,issued_by)
      values(${actor.orgId},${documentId},${invoice.profile},${invoice.typeCode},${invoice.buyerReference ?? null},${fileName},${mediaType},${Buffer.from(content)},${sha256},${digest(xml)},${revision}::bigint,${JSON.stringify(validateEInvoice(invoice))}::jsonb,${actor.actorId}) returning id`)).rows[0];
    if (!issued) throw new EInvoiceConfigurationError('The e-invoice was not archived.');
    const audit = await tx.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values(${actor.orgId},'einvoice_documents',${issued.id},'insert',${JSON.stringify({ documentId, profile: invoice.profile, sha256 })}::jsonb,${actor.actorId})`);
    if (audit.rowCount !== 1) throw new EInvoiceConfigurationError('The e-invoice issuance audit was not recorded.');
    return { id: issued.id, fileName, mediaType, content: new Uint8Array(content), sha256 };
  });
}
