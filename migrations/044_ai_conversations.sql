-- Recovered from the bookofmemes-backend GitHub repo's independent migration
-- history (originally '020_ai_conversations.sql') -- that repo accumulated its own migrations
-- (numbered 002-020 + add_currencies_table) in parallel with this local
-- checkout's own 001-024, both apparently run against the same live Supabase
-- project without ever being reconciled. Renumbered here (025+) to merge both
-- histories into one record without colliding filenames -- content unchanged.

-- ai_conversations: persisted history for Bascardo AI (Screens/BascardoAISearch.js,
-- src/hooks/useAIChat.js). Previously only documented as a comment block in
-- useAIChat.js and never actually run -- confirmed absent from
-- myDatabasesvhema.js (the live FK reference dump). Without this table,
-- useAIChat.js's loadHistory/sendMessage calls silently no-op on the
-- persistence step (still show the reply in-session, just don't save it).
--
-- Follows the same FK convention as every other user-owned table in this
-- schema (messages.sender_id, comments.user_id, etc.): references
-- profiles(id), not auth.users(id) directly.

CREATE TABLE IF NOT EXISTS ai_conversations (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role        text        NOT NULL CHECK (role IN ('user', 'assistant')),
  content     text        NOT NULL,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_conversations_user_created_idx
  ON ai_conversations(user_id, created_at);

ALTER TABLE ai_conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ai_conversations_select" ON ai_conversations;
CREATE POLICY "ai_conversations_select" ON ai_conversations FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "ai_conversations_insert" ON ai_conversations;
CREATE POLICY "ai_conversations_insert" ON ai_conversations FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "ai_conversations_delete" ON ai_conversations;
CREATE POLICY "ai_conversations_delete" ON ai_conversations FOR DELETE USING (auth.uid() = user_id);

GRANT SELECT, INSERT, DELETE ON ai_conversations TO authenticated;

-- Verify
SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'ai_conversations';
SELECT tablename, policyname, cmd FROM pg_policies WHERE tablename = 'ai_conversations' ORDER BY cmd;
