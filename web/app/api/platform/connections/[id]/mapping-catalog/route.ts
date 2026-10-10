import { NextResponse } from 'next/server';
import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { notFound } from '@/lib/api/responses';
import { buildSource, getConnection } from '@openbooks/engine/src/sync/connection.ts';
import { connectionEntityMappingMetadata, mappingReferenceChoices } from '@openbooks/engine/src/sync/entity-mappings.ts';
import { connectionConfigUrlRefusal } from '../../_connector-guard';

export const runtime = 'nodejs';
export const maxDuration = 60;
const query = z.object({ entity: z.string().max(120).optional(), target: z.string().max(240).optional(), sourceField: z.string().max(240).optional(), q: z.string().trim().max(120).optional(), selected: z.string().max(240).optional() }).strict();

export const GET = defineRoute({
  permission: 'admin.setup.manage', scope: 'unrestricted',
  feature: { none: 'Connection mappings belong to organization setup and retain native feature enforcement during sync.' },
  params: z.object({ id: z.string().uuid() }),
  handler: async ({ request, params: { id }, authz }) => {
    const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success || ((parsed.data.target || parsed.data.sourceField) && !parsed.data.entity) || (parsed.data.target && parsed.data.sourceField) || ((parsed.data.q || parsed.data.selected) && !parsed.data.target && !parsed.data.sourceField)) return NextResponse.json({ error: 'Choose a supported entity and mapping field' }, { status: 422 });
    const connection = await getConnection(authz.user.orgId, id);
    if (!connection) return notFound('record');
    const urlError = await connectionConfigUrlRefusal(connection.config);
    if (urlError) return NextResponse.json({ error: urlError }, { status: 422 });
    try {
      const source = buildSource(connection);
      const entities = await connectionEntityMappingMetadata(source, authz.user.orgId, parsed.data.entity);
      if (!parsed.data.entity) return NextResponse.json({ entities });
      const entity = entities.find(entity => entity.key === parsed.data.entity);
      if (!entity) return NextResponse.json({ error: 'This connector does not sync the selected entity' }, { status: 422 });
      if (parsed.data.target || parsed.data.sourceField) {
        const field = (parsed.data.sourceField ? entity.sourceFields : entity.nativeFields).find(field => field.key === (parsed.data.target ?? parsed.data.sourceField));
        if (!field) return NextResponse.json({ error: 'The native field is no longer available' }, { status: 422 });
        return NextResponse.json({ options: await mappingReferenceChoices(authz.user.orgId, field, source, Boolean(parsed.data.sourceField), parsed.data.q, parsed.data.selected) });
      }
      return NextResponse.json({ entity: { ...entity, sourceFields: [...entity.sourceFields, ...(await source.mappingSourceFields?.(entity.key) ?? [])] } });
    } catch (cause) {
      return NextResponse.json({ error: cause instanceof Error ? cause.message : 'Mapping metadata is unavailable; check source read access and retry' }, { status: 422 });
    }
  },
});
