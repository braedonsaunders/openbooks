-- Refuse a partial installation of governed agency accounting.
SELECT 'agency accounting is partially installed' AS issue WHERE to_regclass('public.drop_ship_agent_allocations') IS NOT NULL OR to_regprocedure('public.drop_ship_control_binding()') IS NOT NULL;
