-- 066: schema_dump(): the whole public schema as one JSON value, so
-- `node scripts/dumpSchema.js` can refresh database-schema.json at the repo
-- root without anyone pasting query results by hand.
--
-- Read-only and callable by the service role only (the backend key); clients
-- (anon/authenticated) can't run it.
BEGIN;

CREATE OR REPLACE FUNCTION public.schema_dump()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  SELECT jsonb_build_object(
    'generated_at', now(),
    'tables', (
      SELECT jsonb_agg(jsonb_build_object(
        'table_name', t.table_name,
        'columns', (SELECT jsonb_agg(jsonb_build_object(
            'column_name', c.column_name, 'data_type', c.data_type, 'udt_name', c.udt_name,
            'is_nullable', c.is_nullable, 'column_default', c.column_default) ORDER BY c.ordinal_position)
          FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = t.table_name)
      ) ORDER BY t.table_name)
      FROM information_schema.tables t WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'),
    'primary_keys', (
      SELECT jsonb_agg(jsonb_build_object('table_name', tc.table_name, 'column_name', kcu.column_name) ORDER BY tc.table_name)
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
      WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'),
    'foreign_keys', (
      SELECT jsonb_agg(jsonb_build_object('constraint_name', con.conname, 'table_name', rel.relname,
               'definition', pg_get_constraintdef(con.oid)) ORDER BY rel.relname, con.conname)
      FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid JOIN pg_namespace n ON n.oid = rel.relnamespace
      WHERE n.nspname = 'public' AND con.contype = 'f'),
    'check_constraints', (
      SELECT jsonb_agg(jsonb_build_object('constraint_name', con.conname, 'table_name', rel.relname,
               'definition', pg_get_constraintdef(con.oid)) ORDER BY rel.relname, con.conname)
      FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid JOIN pg_namespace n ON n.oid = rel.relnamespace
      WHERE n.nspname = 'public' AND con.contype = 'c'),
    'indexes', (
      SELECT jsonb_agg(jsonb_build_object('table_name', tablename, 'index_name', indexname, 'definition', indexdef) ORDER BY tablename, indexname)
      FROM pg_indexes WHERE schemaname = 'public'),
    'triggers', (
      SELECT jsonb_agg(jsonb_build_object('table_name', c.relname, 'trigger_name', tg.tgname,
               'definition', pg_get_triggerdef(tg.oid)) ORDER BY c.relname, tg.tgname)
      FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT tg.tgisinternal),
    'rls_enabled', (
      SELECT jsonb_agg(jsonb_build_object('table_name', c.relname, 'rls_enabled', c.relrowsecurity) ORDER BY c.relname)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'),
    'rls_policies', (
      SELECT jsonb_agg(jsonb_build_object('table_name', tablename, 'policy_name', policyname, 'command', cmd,
               'roles', roles, 'using', qual, 'with_check', with_check) ORDER BY tablename, policyname)
      FROM pg_policies WHERE schemaname = 'public'),
    'enums', (
      SELECT jsonb_agg(jsonb_build_object('enum_name', t.typname,
               'values', (SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid)) ORDER BY t.typname)
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typtype = 'e'),
    'functions', (
      SELECT jsonb_agg(jsonb_build_object('function_name', p.proname,
               'arguments', pg_get_function_identity_arguments(p.oid),
               'returns', pg_get_function_result(p.oid),
               'security_definer', p.prosecdef) ORDER BY p.proname)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind = 'f')
  );
$$;
REVOKE ALL ON FUNCTION public.schema_dump() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.schema_dump() TO service_role;

COMMIT;
