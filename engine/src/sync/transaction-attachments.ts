import { sql } from 'drizzle-orm';
import { db } from '../platform/db.ts';
import { s3Enabled } from '../platform/file-storage.ts';
import { isUuid } from '../platform/uuid.ts';
import { AttachmentImportError, type ImportSummary } from './attachment-contract.ts';
import { detectContentType, persistTransactionFile, verifyTransactionFiles } from './transaction-file-storage.ts';

export interface AttachmentTransaction { id: string; sourceRef: string; kind: string }
export interface TransactionAttachment {
  id: string;
  name: string;
  transactionRefs: string[];
  modifiedAt: Date | null;
  size: number | null;
}
export interface TransactionAttachmentProvider {
  source: string;
  refKey: string;
  inventory: (transactions: AttachmentTransaction[]) => Promise<TransactionAttachment[]>;
  download: (attachment: TransactionAttachment) => Promise<Buffer>;
}
export interface AttachmentSyncOptions { orgId: string; connectionId: string; actorId: string | null }

/** Reconcile new relationships even when unchanged bytes need no download. */
export async function linkExistingTransactionFiles(orgId: string, sourceSystem: string, actorId: string | null, links: { sourceId: string; documentId: string }[]): Promise<number> {
  if (!links.length) return 0;
  const unique = [...new Map(links.map((link) => [`${link.sourceId}:${link.documentId}`, link])).values()];
  const values = sql.join(unique.map((link) => sql`(${link.sourceId}, ${link.documentId}::uuid)`), sql`, `);
  return db.transaction(async (tx) => {
    const targets = await tx.execute(sql`select f.id, d.id as document_id from (values ${values}) v(sid, did)
      join files f on f.org_id=${orgId} and f.source_system=${sourceSystem} and f.source_id=v.sid
      join documents d on d.org_id=f.org_id and d.id=v.did for key share of f, d`);
    if (targets.rows.length !== unique.length) throw new Error("Source file or transaction is unavailable in this organization; retry after resolving its identity");
    const result = await tx.execute<{ count: number; auditedCount: number }>(sql`
      with linked as (
        insert into file_attachments (org_id, file_id, target_table, target_id, created_by, created_at)
        select ${orgId}, f.id, 'documents', d.id, ${actorId}, now()
          from (values ${values}) v(sid, did)
          join files f on f.org_id=${orgId} and f.source_system=${sourceSystem} and f.source_id=v.sid
          join documents d on d.org_id=f.org_id and d.id=v.did
        -- Repeated source relationships intentionally retain the existing link.
        on conflict (org_id, file_id, target_table, target_id) do nothing
        returning id, file_id, target_id
      ), audited as (
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        select ${orgId}, 'file_attachments', id, 'insert', jsonb_build_object(
          'event','source_file_linked','before',null,'after',jsonb_build_object('fileId',file_id,'targetTable','documents','targetId',target_id),
          'reason','Synchronize source transaction evidence'), ${actorId} from linked
        returning id
      ) select (select count(*)::int from linked) as count, (select count(*)::int from audited) as "auditedCount"
    `);
    const evidence = result.rows[0];
    if (!evidence || evidence.count !== evidence.auditedCount) throw new Error("Source file relationships were not audited; retry the sync");
    return evidence.count;
  });
}

/** A complete transaction inventory catches up old records independently of the financial cursor. */
export async function syncTransactionAttachments(provider: TransactionAttachmentProvider, options: AttachmentSyncOptions): Promise<ImportSummary> {
  if (!s3Enabled) throw new Error('Configure File Cabinet object storage before syncing transaction documents and files');
  const connection = (await db.execute<{ source: string }>(sql`select source from connections where org_id=${options.orgId} and id=${options.connectionId}`)).rows[0];
  if (!connection || connection.source !== provider.source) throw new Error('Attachment connection does not match this organization and source');
  if (options.actorId) {
    if (!isUuid(options.actorId)) throw new Error('Attachment actor must be an active user in this organization');
    const actor = (await db.execute(sql`select id from users where org_id=${options.orgId} and id=${options.actorId} and is_active`)).rows[0];
    if (!actor) throw new Error('Attachment actor must be an active user in this organization');
  }
  const ambiguousLegacy = (await db.execute(sql`select id from documents where org_id=${options.orgId} and custom->>${provider.refKey} is not null and custom->>'connectionId' is null
    and exists(select 1 from connections where org_id=${options.orgId} and source=${provider.source} and id<>${options.connectionId}) limit 1`)).rows[0];
  if (ambiguousLegacy) throw new Error('Previously synced transactions lack a unique connector identity; resolve the source connection before importing files');
  const transactions = (await db.execute<AttachmentTransaction>(sql`select id, kind, custom->>${provider.refKey} as "sourceRef" from documents
    where org_id=${options.orgId} and custom->>${provider.refKey} is not null
      and (custom->>'connectionId' is null or custom->>'connectionId'=${options.connectionId}) order by id`)).rows;
  const byRef = new Map<string, AttachmentTransaction>();
  for (const transaction of transactions) {
    if (byRef.has(transaction.sourceRef)) throw new Error('Multiple native transactions share one source identity; resolve before syncing files');
    byRef.set(transaction.sourceRef, transaction);
  }
  let inventory: TransactionAttachment[];
  try { inventory = await provider.inventory(transactions); }
  catch (cause) {
    throw new Error(`${provider.source} transaction-file inventory could not be read: ${cause instanceof Error ? cause.message : 'source read failed'}. Check this connection's file and transaction read permissions, then retry.`, { cause });
  }
  if (!Array.isArray(inventory)) throw new Error('Source transaction file inventory is incomplete; retry the sync');
  const files = new Map<string, TransactionAttachment>();
  const links = new Map<string, Set<string>>();
  for (const attachment of inventory) {
    if (typeof attachment.id !== 'string' || !attachment.id || typeof attachment.name !== 'string' || !attachment.name || !Array.isArray(attachment.transactionRefs) || !attachment.transactionRefs.length || (attachment.size != null && (!Number.isSafeInteger(attachment.size) || attachment.size < 0)) || (attachment.modifiedAt && !Number.isFinite(attachment.modifiedAt.getTime()))) throw new Error('Source attachment metadata is incomplete');
    const sourceId = `${options.connectionId}:${attachment.id}`;
    const prior = files.get(sourceId);
    if (prior && (prior.name !== attachment.name || prior.modifiedAt?.getTime() !== attachment.modifiedAt?.getTime() || prior.size !== attachment.size)) throw new Error('Source file changed while its transaction inventory was read; retry the sync');
    files.set(sourceId, attachment);
    const targets = links.get(sourceId) ?? new Set<string>();
    for (const ref of attachment.transactionRefs) {
      const transaction = byRef.get(ref);
      if (!transaction) throw new Error('Attachment source returned a transaction outside the selected connection');
      targets.add(transaction.id);
    }
    links.set(sourceId, targets);
  }
  const summary: ImportSummary = { scope: 'all', requestedSourceFileIds: [], sourceDocuments: transactions.length,
    sourceDocumentsWithoutId: 0, sourceFiles: files.size, sourceLinks: [...links.values()].reduce((sum, ids) => sum + ids.size, 0),
    createdFiles: 0, newVersions: 0, unchangedFiles: 0, skippedUnchanged: 0, createdLinks: 0, failures: 0, failureDetails: [] };
  for (const [sourceId, attachment] of files) {
    try {
      const stored = (await db.execute<{ modifiedAt: Date | string | null; ready: boolean }>(sql`select f.source_modified_at as "modifiedAt",
        (f.storage_kind='s3' and v.storage_kind='s3' and f.content_hash=v.content_hash and f.size_bytes=v.size_bytes) as ready
        from files f left join file_versions v on v.id=f.current_version_id and v.file_id=f.id
        where f.org_id=${options.orgId} and f.source_system=${provider.source} and f.source_id=${sourceId}`)).rows[0];
      const targets = [...links.get(sourceId)!];
      if (attachment.modifiedAt && stored?.ready && stored.modifiedAt && new Date(stored.modifiedAt).getTime() === attachment.modifiedAt.getTime()) {
        summary.skippedUnchanged++;
        summary.createdLinks += await linkExistingTransactionFiles(options.orgId, provider.source, options.actorId, targets.map((documentId) => ({ sourceId, documentId })));
        continue;
      }
      const bytes = await provider.download(attachment);
      if (attachment.size != null && bytes.length !== attachment.size) throw new Error('Source attachment size changed or download is incomplete; retry the sync');
      const saved = await persistTransactionFile({ ...options, sourceSystem: provider.source, source: { id: sourceId, name: attachment.name },
        targetDocumentIds: targets, bytes, contentType: detectContentType(bytes, attachment.name), sourceModifiedAt: attachment.modifiedAt });
      if (saved.created) summary.createdFiles++;
      if (saved.versioned) summary.newVersions++;
      if (saved.unchanged) summary.unchangedFiles++;
      if (saved.stale) summary.skippedUnchanged++;
      summary.createdLinks += saved.createdLinks;
    } catch (cause) {
      summary.failures++;
      summary.failureDetails.push({ fileId: attachment.id, message: cause instanceof Error ? cause.message : 'Transaction file could not be imported' });
    }
  }
  if (summary.failures) throw new AttachmentImportError(summary);
  await verifyTransactionFiles(options.orgId, provider.source, links, false);
  return summary;
}
