-- 051: Google Play Billing credits
--
-- In-app credits are bought only through Google Play Billing (consumable
-- products). The backend checks each purchase token with the Google Play
-- Developer API, then calls credit_play_purchase() with the service role. That
-- credits wallets.wallet_balance, the one spendable balance used by the
-- marketplace, premium and the other products. Credits are closed-loop: no
-- cash-out, no P2P transfer.
--
-- Purchases that are refunded or charged back show up in Google's voided
-- purchases list. The backend sweep calls reverse_play_purchase() for those.

-- ── 1. Purchase record (one row per purchase token, so crediting is idempotent) ─
CREATE TABLE IF NOT EXISTS public.play_purchases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  wallet_id       uuid NOT NULL REFERENCES public.wallets(id) ON DELETE CASCADE,
  product_id      text NOT NULL,
  purchase_token  text NOT NULL UNIQUE,
  order_id        text,
  credits         numeric(12,2) NOT NULL CHECK (credits > 0),
  status          text NOT NULL DEFAULT 'credited' CHECK (status IN ('credited', 'reversed')),
  clawed_back     numeric(12,2) NOT NULL DEFAULT 0,
  raw             jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  reversed_at     timestamptz
);

CREATE INDEX IF NOT EXISTS play_purchases_user_idx ON public.play_purchases (user_id, created_at DESC);

ALTER TABLE public.play_purchases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS play_purchases_owner_select ON public.play_purchases;
CREATE POLICY play_purchases_owner_select ON public.play_purchases
  FOR SELECT USING (auth.uid() = user_id);
-- No INSERT/UPDATE policies: writes only go through the SECURITY DEFINER
-- functions below, called by the backend with the service role.

-- ── 2. wallet_transactions.type whitelist ────────────────────────────────────
-- Superset of every type in 050 (which is not applied yet), plus the two
-- Play Billing types. Keep this list cumulative when adding types later.
ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_type_check;
ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_type_check
  CHECK (type = ANY (ARRAY[
    'deposit'::text, 'cashout'::text, 'cashout_cancelled'::text,
    'token_purchase'::text, 'token_spend'::text, 'token_reward'::text,
    'transfer_in'::text, 'transfer_out'::text, 'transfer_fee'::text,
    'voucher_spend'::text, 'app_purchase'::text,
    'marketplace_listing_fee'::text, 'marketplace_featured_fee'::text,
    'marketplace_purchase'::text, 'marketplace_sale'::text,
    'marketplace_royalty'::text, 'currency_conversion'::text,
    'leadership_game_join_fee'::text, 'leadership_game_prize'::text,
    'ad_campaign_charge'::text, 'ad_campaign_refund'::text,
    'play_purchase'::text, 'play_purchase_reversal'::text
  ]));

-- ── 3. Credit a checked purchase ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.credit_play_purchase(
  p_user_id        uuid,
  p_product_id     text,
  p_purchase_token text,
  p_order_id       text,
  p_credits        numeric,
  p_raw            jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wallet   wallets%ROWTYPE;
  v_existing play_purchases%ROWTYPE;
BEGIN
  IF p_credits IS NULL OR p_credits <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid credit amount');
  END IF;

  SELECT * INTO v_existing FROM play_purchases WHERE purchase_token = p_purchase_token;
  IF FOUND THEN
    IF v_existing.user_id <> p_user_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'Purchase belongs to another account');
    END IF;
    SELECT * INTO v_wallet FROM wallets WHERE id = v_existing.wallet_id;
    RETURN jsonb_build_object('success', true, 'already_credited', true,
                              'credits', v_existing.credits, 'balance', v_wallet.wallet_balance);
  END IF;

  SELECT * INTO v_wallet FROM wallets WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO wallets (user_id, wallet_balance, token_balance) VALUES (p_user_id, 0, 0)
      ON CONFLICT (user_id) DO NOTHING;
    SELECT * INTO v_wallet FROM wallets WHERE user_id = p_user_id FOR UPDATE;
  END IF;

  INSERT INTO play_purchases (user_id, wallet_id, product_id, purchase_token, order_id, credits, raw)
    VALUES (p_user_id, v_wallet.id, p_product_id, p_purchase_token, p_order_id, p_credits, p_raw);

  UPDATE wallets SET wallet_balance = wallet_balance + p_credits, updated_at = now()
    WHERE id = v_wallet.id;

  INSERT INTO wallet_transactions (wallet_id, type, amount, description, status, currency_code, metadata)
    VALUES (v_wallet.id, 'play_purchase', p_credits,
            'Credits purchased on Google Play', 'completed', 'USD',
            jsonb_build_object('product_id', p_product_id, 'order_id', p_order_id));

  RETURN jsonb_build_object('success', true, 'already_credited', false,
                            'credits', p_credits, 'balance', v_wallet.wallet_balance + p_credits);
END;
$$;

-- ── 4. Reverse a refunded / charged-back purchase ────────────────────────────
-- Takes back as much of the credit as the balance still holds (never takes
-- the balance below zero) and records how much was clawed back.
CREATE OR REPLACE FUNCTION public.reverse_play_purchase(p_purchase_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_purchase play_purchases%ROWTYPE;
  v_wallet   wallets%ROWTYPE;
  v_take     numeric;
BEGIN
  SELECT * INTO v_purchase FROM play_purchases WHERE purchase_token = p_purchase_token FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unknown purchase');
  END IF;
  IF v_purchase.status = 'reversed' THEN
    RETURN jsonb_build_object('success', true, 'already_reversed', true);
  END IF;

  SELECT * INTO v_wallet FROM wallets WHERE id = v_purchase.wallet_id FOR UPDATE;
  v_take := LEAST(v_purchase.credits, GREATEST(v_wallet.wallet_balance, 0));

  IF v_take > 0 THEN
    UPDATE wallets SET wallet_balance = wallet_balance - v_take, updated_at = now()
      WHERE id = v_wallet.id;
    INSERT INTO wallet_transactions (wallet_id, type, amount, description, status, currency_code, metadata)
      VALUES (v_wallet.id, 'play_purchase_reversal', -v_take,
              'Google Play purchase refunded', 'completed', 'USD',
              jsonb_build_object('product_id', v_purchase.product_id, 'order_id', v_purchase.order_id,
                                 'credits', v_purchase.credits));
  END IF;

  UPDATE play_purchases SET status = 'reversed', reversed_at = now(), clawed_back = v_take
    WHERE id = v_purchase.id;

  RETURN jsonb_build_object('success', true, 'clawed_back', v_take,
                            'shortfall', v_purchase.credits - v_take);
END;
$$;

REVOKE ALL ON FUNCTION public.credit_play_purchase(uuid, text, text, text, numeric, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reverse_play_purchase(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_play_purchase(uuid, text, text, text, numeric, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.reverse_play_purchase(text) TO service_role;
