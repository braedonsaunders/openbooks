-- Resolve bank-rule validator calls in their owning schema during configuration writes and deployment recovery.
-- Existing criteria, account references, recursion limits and validation results remain unchanged.
CREATE OR REPLACE FUNCTION public.openbooks_bank_rule_criteria_is_valid(value jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE STRICT
    AS $_$
DECLARE
  account_id text;
BEGIN
  IF jsonb_typeof(value) <> 'object'
     OR value->>'version' <> '2'
     OR octet_length(value::text) > 100000
     OR NOT public.openbooks_bank_rule_group_is_valid(value->'match') THEN
    RETURN false;
  END IF;
  IF value ? 'accountScope' THEN
    IF jsonb_typeof(value->'accountScope') <> 'array' THEN
      RETURN false;
    END IF;
    FOR account_id IN SELECT entry FROM jsonb_array_elements_text(value->'accountScope') AS entries(entry)
    LOOP
      IF account_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RETURN false;
      END IF;
    END LOOP;
    IF (SELECT count(*) <> count(DISTINCT entry) FROM jsonb_array_elements_text(value->'accountScope') AS entries(entry)) THEN
      RETURN false;
    END IF;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$_$;

CREATE OR REPLACE FUNCTION public.openbooks_bank_rule_group_is_valid(value jsonb, depth integer DEFAULT 0) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE STRICT
    AS $_$
DECLARE
  rule jsonb;
  field_name text;
  operator_name text;
  scalar_value text;
  numeric_value numeric;
  lower_bound numeric;
  upper_bound numeric;
BEGIN
  IF depth > 4
     OR jsonb_typeof(value) <> 'object'
     OR value->>'combinator' NOT IN ('and', 'or')
     OR jsonb_typeof(value->'rules') <> 'array'
     OR jsonb_array_length(value->'rules') NOT BETWEEN 1 AND 40 THEN
    RETURN false;
  END IF;

  FOR rule IN SELECT element FROM jsonb_array_elements(value->'rules') AS elements(element)
  LOOP
    IF jsonb_typeof(rule) <> 'object' THEN
      RETURN false;
    END IF;
    IF rule ? 'rules' THEN
      IF NOT public.openbooks_bank_rule_group_is_valid(rule, depth + 1) THEN
        RETURN false;
      END IF;
      CONTINUE;
    END IF;

    field_name := rule->>'field';
    operator_name := rule->>'op';
    scalar_value := rule->>'value';

    IF field_name IN ('description', 'payee', 'anyText', 'reference') THEN
      IF operator_name NOT IN ('contains', 'notContains', 'equals', 'startsWith', 'endsWith', 'isBlank')
         OR (operator_name <> 'isBlank' AND (jsonb_typeof(rule->'value') <> 'string' OR btrim(scalar_value) = '' OR length(scalar_value) > 200)) THEN
        RETURN false;
      END IF;
    ELSIF field_name = 'flow' THEN
      IF operator_name <> 'is' OR scalar_value NOT IN ('in', 'out', 'any') THEN
        RETURN false;
      END IF;
    ELSIF field_name = 'source' THEN
      IF operator_name <> 'equals' OR jsonb_typeof(rule->'value') <> 'string'
         OR btrim(scalar_value) = '' OR length(scalar_value) > 40 THEN
        RETURN false;
      END IF;
    ELSIF field_name = 'amount' THEN
      IF operator_name NOT IN ('eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between') THEN
        RETURN false;
      END IF;
      IF operator_name = 'between' THEN
        IF jsonb_typeof(rule->'value') <> 'array'
           OR jsonb_array_length(rule->'value') <> 2
           OR jsonb_typeof(rule->'value'->0) <> 'number'
           OR jsonb_typeof(rule->'value'->1) <> 'number' THEN
          RETURN false;
        END IF;
        lower_bound := (rule->'value'->>0)::numeric;
        upper_bound := (rule->'value'->>1)::numeric;
        IF lower_bound < 0 OR upper_bound < lower_bound THEN
          RETURN false;
        END IF;
      ELSE
        IF jsonb_typeof(rule->'value') <> 'number' THEN
          RETURN false;
        END IF;
        numeric_value := scalar_value::numeric;
        IF numeric_value < 0 THEN
          RETURN false;
        END IF;
      END IF;
    ELSIF field_name = 'date' THEN
      IF operator_name = 'withinDays' THEN
        IF jsonb_typeof(rule->'value') <> 'number' OR scalar_value::numeric <= 0 THEN
          RETURN false;
        END IF;
      ELSIF operator_name IN ('on', 'before', 'after') THEN
        IF jsonb_typeof(rule->'value') <> 'string'
           OR scalar_value !~ '^\d{4}-\d{2}-\d{2}$'
           OR to_char(scalar_value::date, 'YYYY-MM-DD') <> scalar_value THEN
          RETURN false;
        END IF;
      ELSE
        RETURN false;
      END IF;
    ELSE
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR numeric_value_out_of_range THEN
  RETURN false;
END;
$_$;
