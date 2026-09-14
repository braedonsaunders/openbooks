-- OpenBooks forward migration 0139_unified_extensions.
-- One package/version authority: apps + app_versions. Remove the independent
-- module registry and its mirrored app rows. This is a one-time data conversion,
-- not a second runtime or compatibility API. Preserve exact original evidence.
LOCK TABLE public.modules, public.module_versions, public.apps, public.app_versions,
  public.page_specs, public.app_listings, public.flow_gates, public.flow_runs, public.flows, public.org_nav_configs, public.orgs IN ACCESS EXCLUSIVE MODE;

INSERT INTO public.audit_log(org_id,table_name,row_id,action,changes,actor_id)
SELECT m.org_id,'modules',m.id,'update',jsonb_build_object(
  'event','extension_registry_consolidation','reason','Replace duplicate pre-launch package registries with one extension authority',
  'before',to_jsonb(m),'versions',coalesce((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.created_at,v.id) FROM public.module_versions v WHERE v.org_id=m.org_id AND v.module_id=m.id),'[]'::jsonb),
  'after',jsonb_build_object('table','apps','id',coalesce(m.app_id,m.id))),NULL
FROM public.modules m;

-- Material definitions are converted with their original IDs and timestamps.
-- Existing app-backed mirror rows are not copied a second time.
INSERT INTO public.apps(id,org_id,key,name,description,icon_key,status,granted_permissions,created_at,created_by,updated_at,updated_by)
SELECT id,org_id,key,name,description,icon_key,status,
  CASE WHEN EXISTS(SELECT 1 FROM public.module_versions v, LATERAL jsonb_array_elements(coalesce(v.manifest->'contributions','[]')) c
    WHERE v.module_id=m.id AND c->>'kind'='page') AND NOT granted_permissions ? 'admin.customization.manage'
    THEN granted_permissions || '["admin.customization.manage"]'::jsonb ELSE granted_permissions END,
  created_at,created_by,updated_at,updated_by
FROM public.modules m WHERE m.kind='module';

INSERT INTO public.app_versions(id,org_id,app_id,version,manifest,status,created_at,created_by,updated_at,updated_by)
SELECT v.id,v.org_id,v.module_id,v.version,
  (v.manifest - 'description' - 'provenance') ||
  CASE WHEN jsonb_typeof(v.manifest->'description')='string' THEN jsonb_build_object('description',v.manifest->'description') ELSE '{}'::jsonb END ||
  jsonb_build_object('frontend',jsonb_build_object('renderer','native','entry','frontend/ui.json'),'endpoints','[]'::jsonb,
    'permissions',CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(v.manifest->'contributions','[]')) c WHERE c->>'kind'='page') AND NOT coalesce(v.manifest->'permissions','[]') ? 'admin.customization.manage'
      THEN coalesce(v.manifest->'permissions','[]') || '["admin.customization.manage"]'::jsonb ELSE coalesce(v.manifest->'permissions','[]') END),
  CASE WHEN v.id=m.active_version_id THEN 'active' WHEN v.status='pending' THEN 'draft' ELSE 'superseded' END,
  v.created_at,v.created_by,v.updated_at,v.updated_by
FROM public.module_versions v JOIN public.modules m ON m.org_id=v.org_id AND m.id=v.module_id WHERE m.kind='module';

-- A converted package's workspace links to its projected native pages; the
-- page contributions themselves retain their exact specs and version IDs.
INSERT INTO public.app_files(org_id,app_id,version_id,path,kind,content_type,content,is_binary,size,created_by,updated_by)
SELECT v.org_id,v.app_id,v.id,'frontend/ui.json','frontend','application/json',ui.content,false,octet_length(ui.content),v.created_by,v.updated_by
FROM public.app_versions v JOIN public.modules m ON m.id=v.app_id AND m.org_id=v.org_id AND m.kind='module'
CROSS JOIN LATERAL (SELECT jsonb_build_object('screens',jsonb_build_array(jsonb_build_object(
  'key','overview','title',m.name,'kind','page','spec',jsonb_build_object('specVersion',1,'layout','list',
  'header',jsonb_build_array(jsonb_build_object('kind','page-header','title',m.name)),
  'body',coalesce((SELECT jsonb_agg(jsonb_build_object('kind','widget','widget','link-button','props',jsonb_build_object('href',c->>'route','label',c->>'route')))
    FROM jsonb_array_elements(coalesce(v.manifest->'contributions','[]')) c WHERE c->>'kind'='page'),'[]'::jsonb)
))))::text AS content) ui;
UPDATE public.apps a SET active_version_id=m.active_version_id FROM public.modules m WHERE m.kind='module' AND a.id=m.id AND a.org_id=m.org_id;

-- Marketplace snapshots use the same package contract; unpublished source and
-- existing active installs remain independent immutable snapshots.
INSERT INTO public.audit_log(org_id,table_name,row_id,action,changes,actor_id)
SELECT publisher_org_id,'app_listings',id,'update',jsonb_build_object('event','extension_registry_consolidation','before',to_jsonb(l),'reason','Retire a module-only listing; publish a reviewed unified extension package'),NULL
FROM public.app_listings l WHERE manifest ? 'contributions' AND NOT manifest ? 'frontend';
UPDATE public.app_listings SET is_active=false WHERE manifest ? 'contributions' AND NOT manifest ? 'frontend';

-- Pending approvals cannot approve a different package shape. Close them with
-- evidence; authors submit a new exact-hash extension draft for review.
INSERT INTO public.audit_log(org_id,table_name,row_id,action,changes,actor_id)
SELECT org_id,'flow_gates',id,'update',jsonb_build_object('event','extension_registry_consolidation','before',to_jsonb(g),'after',jsonb_build_object('status','cancelled'),'reason','Resubmit as a reviewed extension draft'),NULL
FROM public.flow_gates g WHERE subject_kind='module_version' AND status IN ('pending','escalated');
UPDATE public.flow_gates SET status='cancelled',comment='Package registry consolidated; resubmit as a reviewed extension draft' WHERE subject_kind='module_version' AND status IN ('pending','escalated');
INSERT INTO public.audit_log(org_id,table_name,row_id,action,changes,actor_id)
SELECT org_id,'flow_runs',id,'update',jsonb_build_object('event','extension_registry_consolidation','before',to_jsonb(r),
  'after',jsonb_build_object('status','cancelled','finished_at',now()),'reason','Retire the removed module-specific approval protocol'),NULL
FROM public.flow_runs r WHERE subject_kind='module_version' AND status IN ('running','waiting');
UPDATE public.flow_runs SET status='cancelled',finished_at=now() WHERE subject_kind='module_version' AND status IN ('running','waiting');

-- Stored configuration is converted once; runtime code recognizes only the
-- canonical names. Keep complete navigation and affected setting before-images.
DO $$
DECLARE r record; old_key text; new_key text; result jsonb; grp jsonb; item jsonb;
  groups_out jsonb; items_out jsonb; prefer_canonical boolean; placed boolean;
  before_values jsonb; after_values jsonb;
BEGIN
  FOR r IN SELECT id,settings FROM public.orgs WHERE settings ?| ARRAY['moduleSettings','moduleSettingsHistory'] FOR UPDATE LOOP
    result := r.settings;
    before_values := jsonb_build_object('moduleSettings',result->'moduleSettings','moduleSettingsHistory',result->'moduleSettingsHistory',
      'extensionSettings',result->'extensionSettings','extensionSettingsHistory',result->'extensionSettingsHistory');
    FOREACH old_key IN ARRAY ARRAY['moduleSettings','moduleSettingsHistory'] LOOP
      new_key := CASE old_key WHEN 'moduleSettings' THEN 'extensionSettings' ELSE 'extensionSettingsHistory' END;
      IF result ? old_key THEN
        IF result ? new_key AND result->new_key IS DISTINCT FROM result->old_key THEN
          RAISE EXCEPTION 'Conflicting extension configuration for organization %',r.id;
        END IF;
        result := (result-old_key) || jsonb_build_object(new_key,result->old_key);
      END IF;
    END LOOP;
    after_values := jsonb_build_object('extensionSettings',result->'extensionSettings','extensionSettingsHistory',result->'extensionSettingsHistory');
    UPDATE public.orgs SET settings=result WHERE id=r.id;
    INSERT INTO public.audit_log(org_id,table_name,row_id,action,changes,actor_id)
      VALUES(r.id,'orgs',r.id,'update',jsonb_build_object('event','extension_registry_consolidation',
        'reason','Move configuration to the sole extension settings authority','before',before_values,'after',after_values),NULL);
  END LOOP;
  FOR r IN SELECT id,org_id,config FROM public.org_nav_configs FOR UPDATE LOOP
    IF jsonb_typeof(r.config->'groups') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Invalid navigation configuration for organization %',r.org_id;
    END IF;
    prefer_canonical := EXISTS(SELECT 1 FROM jsonb_array_elements(r.config->'groups') g,
      LATERAL jsonb_array_elements(g->'items') i WHERE i->>'kind'='module' AND i->>'moduleKey' IN ('admin-modules','admin-extensions'));
    placed := false; groups_out := '[]'::jsonb;
    FOR grp IN SELECT value FROM jsonb_array_elements(r.config->'groups') LOOP
      items_out := '[]'::jsonb;
      FOR item IN SELECT value FROM jsonb_array_elements(grp->'items') LOOP
        IF item->>'kind'='module' AND item->>'moduleKey' IN ('admin-apps','admin-modules','admin-extensions') THEN
          IF placed OR (prefer_canonical AND item->>'moduleKey'='admin-apps') THEN CONTINUE; END IF;
          item := jsonb_set(item,'{moduleKey}','"admin-extensions"');
          IF item->>'label' IN ('Modules','Apps','App Builder') THEN item := item-'label'; END IF;
          placed := true;
        ELSIF item->>'kind'='link' THEN
          IF item ? 'moduleKey' THEN
            IF item ? 'extensionKey' AND item->'extensionKey' IS DISTINCT FROM item->'moduleKey' THEN
              RAISE EXCEPTION 'Conflicting navigation ownership for organization %',r.org_id;
            END IF;
            item := (item-'moduleKey') || jsonb_build_object('extensionKey',item->'moduleKey');
          END IF;
          IF item->>'href' IN ('/admin/apps','/admin/modules') THEN item := jsonb_set(item,'{href}','"/admin/extensions"'); END IF;
        END IF;
        items_out := items_out || jsonb_build_array(item);
      END LOOP;
      groups_out := groups_out || jsonb_build_array(jsonb_set(grp,'{items}',items_out));
    END LOOP;
    result := jsonb_set(r.config,'{groups}',groups_out);
    IF result IS DISTINCT FROM r.config THEN
      UPDATE public.org_nav_configs SET config=result,updated_at=now() WHERE id=r.id;
      INSERT INTO public.audit_log(org_id,table_name,row_id,action,changes,actor_id)
        VALUES(r.org_id,'org_nav_configs',r.id,'update',jsonb_build_object('event','extension_registry_consolidation',
          'reason','Use the canonical extension inventory and contribution ownership','before',r.config,'after',result),NULL);
    END IF;
  END LOOP;
END $$;

INSERT INTO public.audit_log(org_id,table_name,row_id,action,changes,actor_id)
SELECT org_id,'flows',id,'update',jsonb_build_object('event','extension_registry_consolidation','before',to_jsonb(f),
  'after',jsonb_build_object('enabled',false),'reason','Retire the removed module-specific approval protocol'),NULL
FROM public.flows f WHERE subject_kind='module_version' AND enabled;
UPDATE public.flows SET enabled=false,updated_at=now() WHERE subject_kind='module_version' AND enabled;

CREATE UNIQUE INDEX app_versions_org_id_unique ON public.app_versions(org_id,id);
CREATE UNIQUE INDEX app_versions_org_app_id_unique ON public.app_versions(org_id,app_id,id);
ALTER TABLE public.apps ADD CONSTRAINT apps_active_version_owner_fkey FOREIGN KEY(org_id,id,active_version_id) REFERENCES public.app_versions(org_id,app_id,id) ON DELETE SET NULL(active_version_id) DEFERRABLE;

ALTER TABLE public.page_specs DROP CONSTRAINT page_specs_module_version_id_fkey;
ALTER TABLE public.page_specs RENAME COLUMN module_version_id TO extension_version_id;
ALTER TABLE public.page_specs ADD CONSTRAINT page_specs_extension_version_id_fkey
  FOREIGN KEY(org_id,extension_version_id) REFERENCES public.app_versions(org_id,id) ON DELETE RESTRICT DEFERRABLE;
ALTER INDEX public.page_specs_module_version RENAME TO page_specs_extension_version;
ALTER TABLE public.modules DROP CONSTRAINT modules_active_version_owner_fkey;
ALTER TABLE public.modules DROP CONSTRAINT modules_active_version_id_fkey;
DROP TABLE public.module_versions;
DROP TABLE public.modules;
DROP FUNCTION IF EXISTS public.module_version_immutability_guard();

COMMENT ON TABLE public.apps IS 'Organization-scoped extension packages: the sole ownership, grant and active-version authority. Apps is the workspace launcher.';
COMMENT ON COLUMN public.page_specs.extension_version_id IS 'The owning extension version, or NULL for a directly authored tenant layout.';

-- Activated source is changed by appending a reviewed package version only.
CREATE FUNCTION public.extension_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.org_id,NEW.app_id,NEW.version,NEW.manifest,NEW.created_at,NEW.created_by)
    IS DISTINCT FROM (OLD.id,OLD.org_id,OLD.app_id,OLD.version,OLD.manifest,OLD.created_at,OLD.created_by) THEN
    RAISE EXCEPTION 'Extension versions are immutable; create a reviewed revision';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER extension_version_immutable BEFORE UPDATE ON public.app_versions FOR EACH ROW EXECUTE FUNCTION public.extension_version_immutable();
CREATE FUNCTION public.extension_file_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.org_id,NEW.app_id,NEW.version_id,NEW.path,NEW.kind,NEW.content_type,NEW.content,NEW.is_binary,NEW.size,NEW.created_at,NEW.created_by)
    IS DISTINCT FROM (OLD.id,OLD.org_id,OLD.app_id,OLD.version_id,OLD.path,OLD.kind,OLD.content_type,OLD.content,OLD.is_binary,OLD.size,OLD.created_at,OLD.created_by) THEN
    RAISE EXCEPTION 'Extension files are immutable; create a reviewed revision';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER extension_file_immutable BEFORE UPDATE ON public.app_files FOR EACH ROW EXECUTE FUNCTION public.extension_file_immutable();
