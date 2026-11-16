-- ─── 1. Add new content types ────────────────────────────────────────────────
INSERT INTO universal_items (item_type)
VALUES ('music_box'), ('tv_box'), ('podcast_box')
ON CONFLICT (item_type) DO NOTHING;

-- ─── 2. Daily reward claims tracker ──────────────────────────────────────────
-- Tracks which activity each premium user completed on each day.
-- Prevents the same activity being claimed twice in one day.
CREATE TABLE IF NOT EXISTS daily_reward_claims (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  activity_type text       NOT NULL,              -- mirrors universal_items.item_type
  claim_date   date        NOT NULL DEFAULT CURRENT_DATE,
  basc_earned  numeric     NOT NULL DEFAULT 2,
  tx_hash      text,                              -- on-chain transaction hash
  created_at   timestamptz NOT NULL DEFAULT now(),

  -- One claim per user per activity per day
  CONSTRAINT unique_daily_claim UNIQUE (user_id, activity_type, claim_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_claims_user_date
  ON daily_reward_claims (user_id, claim_date);

-- ─── 3. Verify ────────────────────────────────────────────────────────────────
SELECT item_type FROM universal_items ORDER BY item_type;
