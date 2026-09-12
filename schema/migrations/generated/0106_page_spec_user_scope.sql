-- OpenBooks forward migration 0106_page_spec_user_scope.
--
-- A layout can now belong to one PERSON as well as to the org.
--
-- Deliberately a column on page_specs rather than a table of its own. This
-- app already carries eight unrelated jsonb models for "what a screen looks
-- like" with nothing composing them, and a ninth would have meant a second
-- history, a second restore, a second validator and a second admin screen
-- for a document of exactly the same shape. One table, one resolution order:
-- the reader's own layout, then the org's, then the built-in.
--
-- `user_id IS NULL` means org-wide, which keeps every existing row meaning
-- precisely what it meant before this migration ran.
--
-- Note what this is NOT. `user_page_layouts` stores per-user hide/reorder
-- PREFERENCES that individual widgets read (the banking roster, the cash
-- cockpit); it is keyed by widget-defined keys, not by route, and it is not a
-- ViewSpec. The two answer different questions and neither replaces the
-- other: that one is "which accounts do I want to see", this one is "what is
-- on this page".

ALTER TABLE public.page_specs
    ADD COLUMN user_id uuid;

ALTER TABLE public.page_specs
    ADD CONSTRAINT page_specs_user_id_fkey
    FOREIGN KEY (user_id)
    REFERENCES public.users (id)
    ON DELETE CASCADE;

-- The old index enforced one active layout per route per org. That is still
-- true for org-wide rows, and must now also be true per person, so it is
-- replaced by a pair: one partial index for each scope. A single index over
-- `coalesce(user_id, …)` would have worked too, and reads worse.
DROP INDEX IF EXISTS public.page_specs_active_route;

CREATE UNIQUE INDEX page_specs_active_org_route ON public.page_specs
    USING btree (org_id, route) WHERE (is_active AND user_id IS NULL);

CREATE UNIQUE INDEX page_specs_active_user_route ON public.page_specs
    USING btree (org_id, user_id, route) WHERE (is_active AND user_id IS NOT NULL);

-- Resolution reads the caller's own layout first, so that lookup gets its own
-- index rather than riding one built for the org-wide case.
CREATE INDEX page_specs_user_route ON public.page_specs
    USING btree (org_id, user_id, route) WHERE (user_id IS NOT NULL);

COMMENT ON COLUMN public.page_specs.user_id IS
  'The one person this layout is for, or NULL for the whole org. A personal layout wins over the org layout for its owner and changes nothing for anyone else.';
