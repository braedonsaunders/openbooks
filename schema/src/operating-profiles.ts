import { sql } from 'drizzle-orm'
import { boolean, check, foreignKey, type PgTableExtraConfigValue, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { auditColumns, id, orgRef } from './helpers'
import { departments } from './core'

export const operatingProfiles = pgTable('operating_profiles', {
  id: id(), orgId: orgRef(), code: text('code').notNull(), name: text('name').notNull(),
  family: text('family', { enum: ['project', 'production'] }).notNull(),
  currentVersionId: uuid('current_version_id'), isActive: boolean('is_active').notNull().default(true), ...auditColumns,
}, (t): PgTableExtraConfigValue[] => [
  uniqueIndex('operating_profiles_org_id_id_unique').on(t.orgId, t.id),
  uniqueIndex('operating_profiles_org_code_unique').on(t.orgId, t.code),
  uniqueIndex('operating_profiles_org_id_family_unique').on(t.orgId, t.id, t.family),
  foreignKey({ name:'operating_profile_current_version_fk',columns:[t.orgId,t.id,t.currentVersionId],foreignColumns:[operatingProfileVersions.orgId,operatingProfileVersions.profileId,operatingProfileVersions.id] }),
  check('operating_profiles_family_check', sql`${t.family} in ('project','production')`),
])

export const operatingProfileVersions = pgTable('operating_profile_versions', {
  id: id(), orgId: orgRef(), profileId: uuid('profile_id').notNull(), version: integer('version').notNull(),
  family: text('family', { enum: ['project', 'production'] }).notNull(), definition: jsonb('definition').notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  publishedBy: uuid('published_by').notNull(), reason: text('reason').notNull(),
}, (t): PgTableExtraConfigValue[] => [
  uniqueIndex('operating_profile_versions_org_id_id_unique').on(t.orgId, t.id),
  uniqueIndex('operating_profile_versions_org_profile_version_unique').on(t.orgId, t.profileId, t.version),
  uniqueIndex('operating_profile_versions_org_profile_id_unique').on(t.orgId, t.profileId, t.id),
  foreignKey({ name: 'operating_profile_version_family_fk', columns: [t.orgId, t.profileId, t.family], foreignColumns: [operatingProfiles.orgId, operatingProfiles.id, operatingProfiles.family] }),
  check('operating_profile_version_positive', sql`${t.version}>0`),
  check('operating_profile_definition_family', sql`jsonb_typeof(${t.definition})='object' and ${t.definition}->>'family'=${t.family}`),
])

export const operatingProfileScopes = pgTable('operating_profile_scopes', {
  id: id(), orgId: orgRef(), departmentId: uuid('department_id'), family: text('family', { enum: ['project', 'production'] }).notNull(),
  profileIds: jsonb('profile_ids').$type<string[]>().notNull(), defaultProfileId: uuid('default_profile_id'),
  revision: integer('revision').notNull().default(1), ...auditColumns,
}, (t): PgTableExtraConfigValue[] => [
  uniqueIndex('operating_profile_scope_identity').on(t.orgId, t.departmentId, t.family).nullsNotDistinct(),
  uniqueIndex('operating_profile_scopes_org_id_id_unique').on(t.orgId, t.id),
  foreignKey({ name: 'operating_profile_scope_department_fk', columns: [t.orgId, t.departmentId], foreignColumns: [departments.orgId, departments.id] }),
  foreignKey({ name: 'operating_profile_scope_default_fk', columns: [t.orgId, t.defaultProfileId, t.family], foreignColumns: [operatingProfiles.orgId, operatingProfiles.id, operatingProfiles.family] }),
  check('operating_profile_scope_revision_positive', sql`${t.revision}>0`),
  check('operating_profile_scope_profile_ids_array', sql`jsonb_typeof(${t.profileIds})='array'`),
])
