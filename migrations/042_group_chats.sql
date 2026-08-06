-- Recovered from the bookofmemes-backend GitHub repo's independent migration
-- history (originally '019_group_chats.sql') -- that repo accumulated its own migrations
-- (numbered 002-020 + add_currencies_table) in parallel with this local
-- checkout's own 001-024, both apparently run against the same live Supabase
-- project without ever being reconciled. Renumbered here (025+) to merge both
-- histories into one record without colliding filenames -- content unchanged.

-- Group chat feature (Screens/Profile/GroupChat.js, GroupChatCreation.js,
-- src/services/groupChatService.js). This SQL previously lived only as a
-- comment block at the top of groupChatService.js and was never actually
-- run -- confirmed via a live anon-key REST probe: all three tables return
-- 42P01 "relation does not exist". Every group-chat call has been failing
-- since the feature was written. Moving it into a real, trackable migration.
--
-- Tables are created first, then policies -- group_chats' own SELECT policy
-- references group_members, so that table has to exist before the policy
-- referencing it can be created (a prior version of this file interleaved
-- CREATE TABLE with CREATE POLICY per-table and failed with 42P01 on
-- group_members for exactly this reason).

CREATE TABLE IF NOT EXISTS group_chats (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  description text,
  avatar_url text,
  created_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  invite_code text UNIQUE DEFAULT encode(gen_random_bytes(8), 'hex'),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_members (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id uuid REFERENCES group_chats(id) ON DELETE CASCADE NOT NULL,
  user_id uuid REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  role text DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  joined_at timestamptz DEFAULT now(),
  UNIQUE(group_id, user_id)
);

CREATE TABLE IF NOT EXISTS group_messages (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id uuid REFERENCES group_chats(id) ON DELETE CASCADE NOT NULL,
  sender_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  content text,
  message_type text DEFAULT 'text',
  media_url text,
  reply_to_id uuid REFERENCES group_messages(id) ON DELETE SET NULL,
  deleted_at timestamptz,
  edited_at timestamptz,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE group_chats    ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_messages ENABLE ROW LEVEL SECURITY;

-- ── group_chats policies ──────────────────────────────────────────────────
DROP POLICY IF EXISTS "group_chats_select" ON group_chats;
CREATE POLICY "group_chats_select" ON group_chats FOR SELECT USING (
  EXISTS (SELECT 1 FROM group_members WHERE group_id = group_chats.id AND user_id = auth.uid())
);
DROP POLICY IF EXISTS "group_chats_insert" ON group_chats;
CREATE POLICY "group_chats_insert" ON group_chats FOR INSERT WITH CHECK (auth.uid() = created_by);
DROP POLICY IF EXISTS "group_chats_update" ON group_chats;
CREATE POLICY "group_chats_update" ON group_chats FOR UPDATE USING (
  EXISTS (SELECT 1 FROM group_members WHERE group_id = group_chats.id AND user_id = auth.uid() AND role = 'admin')
);

-- ── group_members policies ────────────────────────────────────────────────
DROP POLICY IF EXISTS "group_members_select" ON group_members;
CREATE POLICY "group_members_select" ON group_members FOR SELECT USING (true);
DROP POLICY IF EXISTS "group_members_insert" ON group_members;
CREATE POLICY "group_members_insert" ON group_members FOR INSERT WITH CHECK (
  auth.uid() = user_id OR
  EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = group_id AND gm.user_id = auth.uid() AND gm.role = 'admin')
);
DROP POLICY IF EXISTS "group_members_delete" ON group_members;
CREATE POLICY "group_members_delete" ON group_members FOR DELETE USING (
  auth.uid() = user_id OR
  EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = group_id AND gm.user_id = auth.uid() AND gm.role = 'admin')
);

-- ── group_messages policies ───────────────────────────────────────────────
DROP POLICY IF EXISTS "group_messages_select" ON group_messages;
CREATE POLICY "group_messages_select" ON group_messages FOR SELECT USING (
  EXISTS (SELECT 1 FROM group_members WHERE group_id = group_messages.group_id AND user_id = auth.uid())
);
DROP POLICY IF EXISTS "group_messages_insert" ON group_messages;
CREATE POLICY "group_messages_insert" ON group_messages FOR INSERT WITH CHECK (
  auth.uid() = sender_id AND
  EXISTS (SELECT 1 FROM group_members WHERE group_id = group_messages.group_id AND user_id = auth.uid())
);
DROP POLICY IF EXISTS "group_messages_update" ON group_messages;
CREATE POLICY "group_messages_update" ON group_messages FOR UPDATE USING (auth.uid() = sender_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON group_chats, group_members, group_messages TO authenticated;

-- Verify
SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('group_chats','group_members','group_messages');
SELECT tablename, policyname, cmd FROM pg_policies
WHERE tablename IN ('group_chats','group_members','group_messages')
ORDER BY tablename, cmd;
