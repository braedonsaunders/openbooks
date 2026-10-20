-- Remove the retired graph outcome selector; gate routing is the sole approval policy.
-- Retain every submitted graph snapshot and recorded decision unchanged.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

WITH prior AS MATERIALIZED (
 SELECT id,org_id,graph FROM public.flows WHERE graph ? 'ungatedOutcome' FOR UPDATE
), changed AS (
 UPDATE public.flows f SET graph=f.graph-'ungatedOutcome',updated_at=clock_timestamp(),updated_by=NULL
 FROM prior p WHERE f.org_id=p.org_id AND f.id=p.id
 RETURNING f.id,f.org_id,p.graph AS before_graph,f.graph AS after_graph
)
INSERT INTO public.audit_log(org_id,table_name,row_id,action,actor_id,changes)
SELECT org_id,'flows',id,'update',NULL,jsonb_build_object('reason','Approval routing is governed solely by Flow gates.',
 'before',jsonb_build_object('graph',before_graph),'after',jsonb_build_object('graph',after_graph)) FROM changed;
