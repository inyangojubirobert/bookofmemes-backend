-- Premium subscription billing: voucher credit is consumed first, then the
-- user's real USD wallet balance covers any remainder.
CREATE OR REPLACE FUNCTION public.purchase_premium_subscription()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_subscription subscriptions%ROWTYPE;
  v_charge jsonb;
  v_reference text;
  v_started_at timestamptz := now();
  v_expires_at timestamptz := now() + interval '30 days';
  v_price numeric := 9.99;
  v_voucher_amount numeric;
  v_wallet_amount numeric;
  v_provider text;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not signed in');
  END IF;

  IF EXISTS (
    SELECT 1 FROM subscriptions
    WHERE user_id = v_user_id AND status = 'active' AND expires_at > now()
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Premium subscription is already active');
  END IF;

  v_charge := consume_app_balance(v_price, 'Premium subscription - 30 days');
  IF COALESCE((v_charge->>'success')::boolean, false) IS NOT TRUE THEN
    RETURN v_charge;
  END IF;

  v_voucher_amount := COALESCE((v_charge->>'voucher_amount')::numeric, 0);
  v_wallet_amount := COALESCE((v_charge->>'wallet_amount')::numeric, 0);
  v_provider := CASE
    WHEN v_voucher_amount > 0 AND v_wallet_amount > 0 THEN 'wallet_and_spend_voucher'
    WHEN v_voucher_amount > 0 THEN 'spend_voucher'
    ELSE 'wallet_balance'
  END;
  v_reference := 'SUB-' || upper(substring(gen_random_uuid()::text, 1, 8));

  INSERT INTO subscriptions (user_id, plan_type, status, payment_reference, started_at, expires_at)
  VALUES (v_user_id, 'premium_monthly', 'active', v_reference, v_started_at, v_expires_at)
  RETURNING * INTO v_subscription;

  INSERT INTO subscription_payments
    (subscription_id, user_id, amount, currency, provider, status, payment_reference, paid_at)
  VALUES
    (v_subscription.id, v_user_id, v_price, 'USD', v_provider, 'completed', v_reference, now());

  RETURN jsonb_build_object(
    'success', true,
    'data', jsonb_build_object(
      'subscription_id', v_subscription.id,
      'plan_type', v_subscription.plan_type,
      'price', v_price,
      'currency', 'USD',
      'started_at', v_started_at,
      'expires_at', v_expires_at,
      'reference', v_reference,
      'voucher_amount', v_voucher_amount,
      'wallet_amount', v_wallet_amount
    )
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.purchase_premium_subscription() TO authenticated;
