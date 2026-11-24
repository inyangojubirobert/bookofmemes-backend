-- 089: AI credit top-up packs bought straight through Google Play (one consumable product per pack),
-- next to the existing wallet path (075). A Play purchase is granted once per purchase token
-- (request_id 'play:<token>'), and a refund found by the voided-purchase sweep takes the credits back.
-- Safe to run more than once.

DO $$
BEGIN
  IF to_regclass('public.ai_credit_topups') IS NULL OR to_regclass('public.ai_credit_balance') IS NULL THEN
    RAISE EXCEPTION 'Wrong Supabase project, or 075 is missing: run this in the Book of Memes project (URL starts with zgyphn). Nothing was changed.';
  END IF;
END $$;

ALTER TABLE public.ai_credit_topups ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'wallet';
ALTER TABLE public.ai_credit_topups ADD COLUMN IF NOT EXISTS order_id text;
ALTER TABLE public.ai_credit_topups ADD COLUMN IF NOT EXISTS refunded_at timestamptz;
ALTER TABLE public.ai_credit_topups DROP CONSTRAINT IF EXISTS ai_credit_topups_status_check;
ALTER TABLE public.ai_credit_topups ADD CONSTRAINT ai_credit_topups_status_check CHECK (status IN ('granted', 'failed', 'refunded'));
ALTER TABLE public.ai_credit_topups DROP CONSTRAINT IF EXISTS ai_credit_topups_provider_check;
ALTER TABLE public.ai_credit_topups ADD CONSTRAINT ai_credit_topups_provider_check CHECK (provider IN ('wallet', 'google_play'));

-- A Play purchase: granted once per token. Returns 'granted', 'already' (same user) or 'other_user'.
CREATE OR REPLACE FUNCTION public.grant_ai_topup_play(p_user_id uuid, p_pack text, p_credits int, p_price numeric, p_token text, p_order_id text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE owner uuid;
BEGIN
  SELECT user_id INTO owner FROM ai_credit_topups WHERE request_id = 'play:' || p_token;
  IF FOUND THEN RETURN CASE WHEN owner = p_user_id THEN 'already' ELSE 'other_user' END; END IF;
  INSERT INTO ai_credit_topups (user_id, pack, credits, price_usd, request_id, provider, order_id)
  VALUES (p_user_id, p_pack, p_credits, p_price, 'play:' || p_token, 'google_play', p_order_id);
  INSERT INTO ai_credit_balance (user_id, credits, purchased_total) VALUES (p_user_id, p_credits, p_credits)
  ON CONFLICT (user_id) DO UPDATE SET credits = ai_credit_balance.credits + excluded.credits,
    purchased_total = ai_credit_balance.purchased_total + excluded.credits, updated_at = now();
  RETURN 'granted';
EXCEPTION WHEN unique_violation THEN
  RETURN 'already';
END $$;

-- Refunded by Google Play: take the credits back (as many as are left; never below zero). Once only.
CREATE OR REPLACE FUNCTION public.reverse_ai_topup_play(p_token text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE t ai_credit_topups%ROWTYPE;
BEGIN
  SELECT * INTO t FROM ai_credit_topups WHERE request_id = 'play:' || p_token AND status = 'granted' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE ai_credit_topups SET status = 'refunded', refunded_at = now() WHERE id = t.id;
  UPDATE ai_credit_balance SET credits = GREATEST(0, credits - t.credits), updated_at = now() WHERE user_id = t.user_id;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.grant_ai_topup_play(uuid, text, int, numeric, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reverse_ai_topup_play(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_ai_topup_play(uuid, text, int, numeric, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reverse_ai_topup_play(text) TO service_role;

NOTIFY pgrst, 'reload schema';
