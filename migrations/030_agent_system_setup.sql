-- Recovered from the bookofmemes-backend GitHub repo's independent migration
-- history (originally '007_agent_system_setup.sql') -- that repo accumulated its own migrations
-- (numbered 002-020 + add_currencies_table) in parallel with this local
-- checkout's own 001-024, both apparently run against the same live Supabase
-- project without ever being reconciled. Renumbered here (025+) to merge both
-- histories into one record without colliding filenames -- content unchanged.

-- Migration 007: Trade Agent System — Tiers, Security Deposits, Rates, Limits
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Extend agents table ───────────────────────────────────────────────────

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS user_id            UUID        REFERENCES profiles(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS tier               TEXT        DEFAULT 'starter'
    CHECK (tier IN ('starter','standard','pro','elite','master')),
  ADD COLUMN IF NOT EXISTS status             TEXT        DEFAULT 'pending_verification'
    CHECK (status IN ('pending_verification','active','suspended','rejected')),
  ADD COLUMN IF NOT EXISTS security_balance_usd NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pending_trade_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_active          BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ NOT NULL DEFAULT now();

-- ── 2. Extend agent_kyc table ────────────────────────────────────────────────

ALTER TABLE agent_kyc
  ADD COLUMN IF NOT EXISTS full_name  TEXT,
  ADD COLUMN IF NOT EXISTS id_type    TEXT CHECK (id_type IN ('passport','national_id','drivers_license','voter_card')),
  ADD COLUMN IF NOT EXISTS id_number  TEXT,
  ADD COLUMN IF NOT EXISTS country    TEXT,
  ADD COLUMN IF NOT EXISTS status     TEXT DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected')),
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- ── 3. Extend agent_security_deposits table ──────────────────────────────────

ALTER TABLE agent_security_deposits
  ADD COLUMN IF NOT EXISTS tier         TEXT,
  ADD COLUMN IF NOT EXISTS amount_usdt  NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS amount_usd   NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS network      TEXT CHECK (network IN ('bsc','tron')),
  ADD COLUMN IF NOT EXISTS tx_hash      TEXT,
  ADD COLUMN IF NOT EXISTS status       TEXT DEFAULT 'pending'
    CHECK (status IN ('pending','confirmed','rejected')),
  ADD COLUMN IF NOT EXISTS created_at   TIMESTAMPTZ NOT NULL DEFAULT now();

-- ── 4. Extend agent_rates table ─────────────────────────────────────────────

ALTER TABLE agent_rates
  ADD COLUMN IF NOT EXISTS currency    TEXT,
  ADD COLUMN IF NOT EXISTS buy_rate    NUMERIC(18,6) DEFAULT 1,
  ADD COLUMN IF NOT EXISTS sell_rate   NUMERIC(18,6) DEFAULT 1,
  ADD COLUMN IF NOT EXISTS min_amount  NUMERIC(12,2) DEFAULT 1,
  ADD COLUMN IF NOT EXISTS max_amount  NUMERIC(12,2) DEFAULT 100,
  ADD COLUMN IF NOT EXISTS is_active   BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT now();

-- ── 5. Extend agent_liquidity table ─────────────────────────────────────────

ALTER TABLE agent_liquidity
  ADD COLUMN IF NOT EXISTS available   NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT now();

-- ── 6. Extend agent_stats table ──────────────────────────────────────────────

ALTER TABLE agent_stats
  ADD COLUMN IF NOT EXISTS total_trades    INT     DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_volume    NUMERIC(16,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating          NUMERIC(3,2) DEFAULT 5.00,
  ADD COLUMN IF NOT EXISTS dispute_count   INT     DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();

-- ── 7. Trigger: auto-activate agent when security deposit is confirmed ────────
--     On confirmation: credit agent's USD wallet_currencies balance
--     and set security_balance_usd + is_active + status = 'active'

CREATE OR REPLACE FUNCTION on_security_deposit_confirmed()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id UUID;
  v_usd     NUMERIC(12,2);
BEGIN
  IF NEW.status = 'confirmed' AND OLD.status != 'confirmed' THEN
    -- Get agent's user_id and deposit amount
    SELECT a.user_id, NEW.amount_usd
    INTO v_user_id, v_usd
    FROM agents a WHERE a.id = NEW.agent_id;

    -- Credit USD wallet balance
    UPDATE wallet_currencies wc
    SET    balance = balance + v_usd,
           updated_at = now()
    FROM   wallets w
    WHERE  w.id         = wc.wallet_id
      AND  w.user_id    = v_user_id
      AND  wc.currency_code = 'USD';

    -- Set agent trading limit and activate
    UPDATE agents
    SET  security_balance_usd = security_balance_usd + v_usd,
         status    = 'active',
         is_active = true,
         updated_at = now()
    WHERE id = NEW.agent_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_security_deposit_confirmed ON agent_security_deposits;
CREATE TRIGGER trg_security_deposit_confirmed
  AFTER UPDATE OF status ON agent_security_deposits
  FOR EACH ROW
  EXECUTE FUNCTION on_security_deposit_confirmed();

-- ── 8. Trigger: block agent from open market when pending trades exceed limit ─

CREATE OR REPLACE FUNCTION refresh_agent_active_status()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- An agent is active only if their available balance covers at least $1
  UPDATE agents
  SET  is_active  = (security_balance_usd - pending_trade_amount) >= 1,
       updated_at = now()
  WHERE id = COALESCE(NEW.agent_id, OLD.agent_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agent_order_status ON agent_orders;
CREATE TRIGGER trg_agent_order_status
  AFTER INSERT OR UPDATE OF status ON agent_orders
  FOR EACH ROW
  EXECUTE FUNCTION refresh_agent_active_status();

-- ── 9. Helper view: agents visible in open market ────────────────────────────

CREATE OR REPLACE VIEW active_trade_agents AS
SELECT
  a.id,
  a.user_id,
  a.tier,
  a.security_balance_usd,
  a.pending_trade_amount,
  (a.security_balance_usd - a.pending_trade_amount) AS available_limit,
  p.full_name,
  p.avatar_url,
  ast.rating,
  ast.total_trades
FROM  agents a
JOIN  profiles p   ON p.id  = a.user_id
LEFT JOIN agent_stats ast ON ast.agent_id = a.id
WHERE a.is_active = true
  AND a.status    = 'active'
  AND (a.security_balance_usd - a.pending_trade_amount) >= 1;
