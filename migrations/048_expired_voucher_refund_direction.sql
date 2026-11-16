-- Expiry policy: unused voucher principal returns to the original sender's
-- real USD wallet balance. The recipient never receives an expiry refund, and
-- the transfer fee remains non-refundable platform revenue.
ALTER TABLE public.spend_vouchers
  ADD COLUMN IF NOT EXISTS refunded_to_wallet_id uuid REFERENCES public.wallets(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.spend_vouchers.refunded_to_wallet_id IS
  'Original sender wallet receiving the unspent principal after voucher expiry; never the recipient wallet.';
COMMENT ON COLUMN public.spend_vouchers.refunded_amount IS
  'Unused voucher principal returned to refunded_to_wallet_id. Transfer fees are excluded.';

CREATE OR REPLACE FUNCTION public.expire_spend_vouchers()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_voucher record;
  v_refunded numeric;
  v_count integer := 0;
  v_reference text;
BEGIN
  FOR v_voucher IN
    SELECT * FROM spend_vouchers
    WHERE status = 'active' AND expires_at <= now()
    ORDER BY expires_at, id
    FOR UPDATE SKIP LOCKED
  LOOP
    v_refunded := GREATEST(COALESCE(v_voucher.remaining_amount, 0), 0);
    v_reference := 'VRF-' || upper(substring(gen_random_uuid()::text, 1, 8));

    IF v_refunded > 0 THEN
      UPDATE wallets
      SET wallet_balance = wallet_balance + v_refunded, updated_at = now()
      WHERE id = v_voucher.sender_wallet_id;

      INSERT INTO wallet_ledger
        (wallet_id, transaction_type, debit, credit, balance_before, balance_after, reference_id)
      SELECT
        w.id, 'voucher_expiry_refund', 0, v_refunded,
        w.wallet_balance - v_refunded, w.wallet_balance, v_voucher.id
      FROM wallets w
      WHERE w.id = v_voucher.sender_wallet_id;

      INSERT INTO wallet_transactions
        (wallet_id, type, amount, description, status, currency_code, metadata)
      VALUES
        (v_voucher.sender_wallet_id, 'voucher_expiry_refund', v_refunded,
         'Unused spend voucher balance returned after expiry', 'completed', 'USD',
         jsonb_build_object(
           'voucher_id', v_voucher.id,
           'reference', v_reference,
           'refund_destination', 'sender_wallet_balance',
           'refunded_to_wallet_id', v_voucher.sender_wallet_id,
           'recipient_wallet_id', v_voucher.recipient_wallet_id,
           'refunded_amount', v_refunded,
           'transfer_fee_refunded', false
         ));
    END IF;

    UPDATE spend_vouchers
    SET status = 'expired', expired_at = now(), refunded_amount = v_refunded,
        refunded_to_wallet_id = v_voucher.sender_wallet_id,
        remaining_amount = 0
    WHERE id = v_voucher.id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_spend_vouchers() FROM PUBLIC, anon, authenticated;
