import { sql, type SQL } from 'drizzle-orm';
import { db, withOrg } from '../platform/db.ts';
import { decodeEntityMappings, netSuiteEntityMappingMetadata } from './entity-mapping-contract.ts';
import { createEntityMappingProjector } from './entity-mappings.ts';

/** Operational imports use the same persisted mapping contract as the master and document loaders. */
export async function netSuiteOperationalMappingWriter(orgId: string, connectionId: string, actorId: string | null) {
  const connection = (await db.execute<{ config: Record<string, unknown> }>(sql`select config from connections where id=${connectionId} and org_id=${orgId} and source='netsuite'`)).rows[0];
  if (!connection) throw new Error('The NetSuite connection is not available in this organization');
  if (actorId !== null && !(await db.execute(sql`select id from users where id=${actorId} and org_id=${orgId} and is_active`)).rows[0]) throw new Error('The mapping actor must be an active user in this organization');
  const catalog = netSuiteEntityMappingMetadata().filter(entity => entity.operational);
  const stored = decodeEntityMappings(connection.config.entityMappings);
  const model = { version: 1 as const, entities: Object.fromEntries(Object.entries(stored.entities).filter(([key]) => catalog.some(entity => entity.key === key))) };
  const project = createEntityMappingProjector({ name: 'netsuite', refKey: 'nsId', entityMappingMetadata: catalog }, model, orgId);
  return {
    enabled: (key: string) => Boolean(model.entities[key]?.length),
    write: async (key: string, sourceRef: string, fields: Record<string, unknown>, identity: SQL,
      save: (mapped: Record<string, unknown>) => Promise<string>, beforeLock?: () => Promise<void>): Promise<string> => {
      const entity = catalog.find(entity => entity.key === key);
      if (!entity) throw new Error('This operational entity has no native mapping contract');
      if (!model.entities[key]?.length) return save(fields);
      return withOrg(orgId, async () => {
        await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${orgId}:${connectionId}:${key}:${sourceRef}`},0))`);
        await beforeLock?.();
        const mapped = (await project(key, [{ ref: sourceRef, fields }]))[0]!;
        const before = (await db.execute<{ snapshot: Record<string, unknown> }>(sql`select to_jsonb(t) as snapshot from ${sql.identifier(entity.table)} t where org_id=${orgId} and (${identity}) for update`)).rows;
        if (before.length > 1) throw new Error('The operational source identity is ambiguous');
        const id = await save(mapped.fields);
        if (!id || (before[0] && before[0].snapshot.id !== id)) throw new Error('The mapped operational record did not retain its native identity');
        if (Object.keys(mapped.custom).length || Object.hasOwn(before[0]?.snapshot.custom as object ?? {}, 'connectorMappedValues')) {
          const updated = (await db.execute<{ id: string }>(sql`update ${sql.identifier(entity.table)} set custom=
            (coalesce(custom,'{}'::jsonb) - 'connectorMappedValues')
              || ${JSON.stringify(Object.keys(mapped.custom).length ? { ...mapped.custom, connectorMappedValues: mapped.custom } : {})}::jsonb
            where org_id=${orgId} and id=${id} returning id`)).rows[0];
          if (!updated) throw new Error('The operational custom-field update did not save a record');
        }
        const after = (await db.execute<{ snapshot: Record<string, unknown> }>(sql`select to_jsonb(t) as snapshot from ${sql.identifier(entity.table)} t where org_id=${orgId} and id=${id}`)).rows[0];
        if (!after) throw new Error('The mapped operational record is not readable in this organization');
        if (JSON.stringify(stableMappingSnapshot(before[0]?.snapshot ?? null)) !== JSON.stringify(stableMappingSnapshot(after.snapshot))) {
          const audit = (await db.execute<{ id: string }>(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
            values(${orgId},${entity.table},${id},${before[0] ? 'update' : 'insert'},${JSON.stringify({ event: 'connector_entity_mapping_applied', connectionId, sourceRef, before: before[0]?.snapshot ?? null, after: after.snapshot })}::jsonb,${actorId}) returning id`)).rows[0];
          if (!audit) throw new Error('The operational mapping audit was not saved');
        }
        return id;
      });
    },
  };
}
export type OperationalMappingWriter = Awaited<ReturnType<typeof netSuiteOperationalMappingWriter>>;

/** Extraction timestamps and native revision counters do not create replay-only business audits. */
export function stableMappingSnapshot(value: unknown): unknown {
  return stableSnapshotValue(value, true);
}
function stableSnapshotValue(value: unknown, nativeRow = false): unknown {
  if (Array.isArray(value)) return value.map(entry => stableSnapshotValue(entry));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) =>
    !['updated_at', 'updated_by', 'created_at', 'created_by', 'lastSyncedAt', 'extractedAt'].includes(key)
      && (!nativeRow || key !== 'revision_seq'))
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stableSnapshotValue(entry)]));
}
