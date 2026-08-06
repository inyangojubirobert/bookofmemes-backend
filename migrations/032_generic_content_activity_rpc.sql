-- Recovered from the bookofmemes-backend GitHub repo's independent migration
-- history (originally '009_generic_content_activity_rpc.sql') -- that repo accumulated its own migrations
-- (numbered 002-020 + add_currencies_table) in parallel with this local
-- checkout's own 001-024, both apparently run against the same live Supabase
-- project without ever being reconciled. Renumbered here (025+) to merge both
-- histories into one record without colliding filenames -- content unchanged.

-- Generic content-activity registry + RPC.
--
-- Replaces the frontend's hardcoded QUIZ_RPC_MAP (Screens/HomeStack/universal/
-- renderers/MediaViewer.js) with a DB-owned mapping. To add a new activity
-- type from now on:
--   1. Create a table for it (needs an `id uuid` and a `collection_id uuid`
--      column at minimum, matching the content row it belongs to).
--   2. Set up RLS + GRANT SELECT for anon/authenticated on that table, same
--      as counting_activity already has -- this migration does not do that
--      for you.
--   3. INSERT INTO content_activity_types (item_type, activity_type, table_name) VALUES (...).
--   4. Set `activity_type` on the content row(s) that use it.
-- No app code change or deploy needed for any of the above.

-- 1. Real per-collection activity discriminator (distinct from the generic
--    content-category `type` column, which stays "for kids"/etc unchanged).
ALTER TABLE kids_collections ADD COLUMN IF NOT EXISTS activity_type text;
ALTER TABLE memes            ADD COLUMN IF NOT EXISTS activity_type text;
ALTER TABLE puzzles          ADD COLUMN IF NOT EXISTS activity_type text;

-- Backfill the one existing real collection.
UPDATE kids_collections
SET activity_type = 'counting'
WHERE id = 'abd90033-0f1e-4d12-8048-df9da965c20c' AND activity_type IS NULL;

-- 2. Registry: which physical table backs each (item_type, activity_type).
-- table_name is `regclass`, not `text` -- Postgres resolves/validates it
-- against a real relation at INSERT time, which is also what makes the
-- dynamic SQL in the RPC below safe from injection (it's never a raw string).
CREATE TABLE IF NOT EXISTS content_activity_types (
  item_type     text        NOT NULL,
  activity_type text        NOT NULL,
  table_name    regclass    NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_type, activity_type)
);

ALTER TABLE content_activity_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access" ON content_activity_types FOR SELECT USING (true);
GRANT SELECT ON content_activity_types TO anon, authenticated;

INSERT INTO content_activity_types (item_type, activity_type, table_name)
VALUES ('kids_collections', 'counting', 'counting_activity'::regclass)
ON CONFLICT (item_type, activity_type) DO NOTHING;

-- 3. One RPC for every activity, on every item type, forever.
-- Returns the whole matched row as jsonb so callers don't need to know the
-- backing table's column shape -- a future activity table can add/omit
-- columns freely with no change here.
CREATE OR REPLACE FUNCTION get_random_activity(
  p_item_type     text,
  p_activity_type text,
  p_collection_id uuid,
  exclude_ids     uuid[] DEFAULT '{}'
)
RETURNS TABLE (activity jsonb)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_table regclass;
BEGIN
  SELECT table_name INTO v_table
  FROM content_activity_types
  WHERE item_type = p_item_type AND activity_type = p_activity_type;

  IF v_table IS NULL THEN
    RAISE EXCEPTION 'ACTIVITY_TYPE_NOT_CONFIGURED: % / %', p_item_type, p_activity_type;
  END IF;

  RETURN QUERY EXECUTE format(
    'SELECT to_jsonb(t) FROM %s t WHERE t.collection_id = $1 AND NOT (t.id = ANY($2)) ORDER BY random() LIMIT 1',
    v_table
  ) USING p_collection_id, exclude_ids;
END;
$$;

GRANT EXECUTE ON FUNCTION get_random_activity(text, text, uuid, uuid[]) TO anon, authenticated;

-- 4. Verify
SELECT * FROM content_activity_types ORDER BY item_type, activity_type;
