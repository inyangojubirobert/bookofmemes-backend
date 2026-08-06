-- Recovered from the bookofmemes-backend GitHub repo's independent migration
-- history (originally '006_sync_deposit_status_trigger.sql') -- that repo accumulated its own migrations
-- (numbered 002-020 + add_currencies_table) in parallel with this local
-- checkout's own 001-024, both apparently run against the same live Supabase
-- project without ever being reconciled. Renumbered here (025+) to merge both
-- histories into one record without colliding filenames -- content unchanged.

-- Migration 006: Enforce deposit status ↔ deposit_request status consistency
-- ─────────────────────────────────────────────────────────────────────────────
-- Problem: when a deposit_request is rejected/confirmed, the parent deposit's
-- status was only updated by frontend code. If the frontend call fails, the
-- deposit stays 'pending' forever and DepositRecord / DepositNotifications
-- show conflicting data.
--
-- Solution:
--   1. A TRIGGER that automatically syncs deposits.status + inserts a
--      deposit_notification whenever a deposit_request status changes.
--   2. A one-time repair that fixes existing stale rows.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── STEP 1: Trigger function ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION sync_deposit_status_on_request_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id   UUID;
  v_amount    NUMERIC;
  v_currency  TEXT;
  v_sym       TEXT;
  v_fmt_amt   TEXT;
BEGIN
  -- Only act when the status column actually changed
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  -- Grab the deposit owner + amount for notification text
  SELECT user_id, amount, currency
  INTO v_user_id, v_amount, v_currency
  FROM deposits
  WHERE id = NEW.deposit_id;

  -- Simple currency symbol lookup
  v_sym := CASE v_currency
    WHEN 'NGN' THEN '₦'
    WHEN 'USD' THEN '$'
    WHEN 'EUR' THEN '€'
    WHEN 'GBP' THEN '£'
    ELSE '$'
  END;

  v_fmt_amt := v_sym || TO_CHAR(v_amount, 'FM999,999,999.00');

  -- ── confirmed → deposit becomes completed ─────────────────────────────────
  IF NEW.status = 'confirmed' THEN
    UPDATE deposits
    SET status = 'completed'
    WHERE id = NEW.deposit_id
      AND status NOT IN ('completed');        -- idempotent

    INSERT INTO deposit_notifications (user_id, deposit_id, title, message)
    SELECT v_user_id, NEW.deposit_id,
      'Pair Device Deposit Confirmed',
      'Your pair device deposit of ' || v_fmt_amt || ' ' || v_currency ||
      ' has been confirmed. Funds are now available in your wallet.'
    WHERE v_user_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM deposit_notifications
        WHERE deposit_id = NEW.deposit_id AND title = 'Pair Device Deposit Confirmed'
      );

  -- ── rejected → deposit becomes failed ────────────────────────────────────
  ELSIF NEW.status = 'rejected' THEN
    UPDATE deposits
    SET status = 'failed'
    WHERE id = NEW.deposit_id
      AND status NOT IN ('completed', 'failed');  -- idempotent

    INSERT INTO deposit_notifications (user_id, deposit_id, title, message)
    SELECT v_user_id, NEW.deposit_id,
      'Deposit Request Declined',
      'Your pair device deposit request of ' || v_fmt_amt || ' ' || v_currency ||
      ' was declined by the recipient. Please try again with a different account or deposit method.'
    WHERE v_user_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM deposit_notifications
        WHERE deposit_id = NEW.deposit_id AND title = 'Deposit Request Declined'
      );

  -- ── cancelled → deposit becomes cancelled ────────────────────────────────
  ELSIF NEW.status = 'cancelled' THEN
    UPDATE deposits
    SET status = 'cancelled'
    WHERE id = NEW.deposit_id
      AND status NOT IN ('completed', 'failed', 'cancelled');  -- idempotent
  END IF;

  RETURN NEW;
END;
$$;

-- Attach trigger to deposit_requests
DROP TRIGGER IF EXISTS trg_sync_deposit_status ON deposit_requests;
CREATE TRIGGER trg_sync_deposit_status
  AFTER UPDATE OF status ON deposit_requests
  FOR EACH ROW
  EXECUTE FUNCTION sync_deposit_status_on_request_change();


-- ── STEP 2: One-time repair of existing stale data ──────────────────────────

-- Fix deposits that have a rejected request but are still 'pending'
UPDATE deposits d
SET    status = 'failed'
FROM   deposit_requests dr
WHERE  dr.deposit_id = d.id
  AND  dr.status     = 'rejected'
  AND  d.status      = 'pending';

-- Insert missing 'Deposit Request Declined' notifications for those deposits
INSERT INTO deposit_notifications (user_id, deposit_id, title, message)
SELECT
  d.user_id,
  d.id,
  'Deposit Request Declined',
  'Your pair device deposit request was declined by the recipient. ' ||
  'Please try again with a different account or deposit method.'
FROM  deposits d
JOIN  deposit_requests dr ON dr.deposit_id = d.id
WHERE dr.status = 'rejected'
  AND d.status  = 'failed'
  AND NOT EXISTS (
    SELECT 1 FROM deposit_notifications dn
    WHERE  dn.deposit_id = d.id
      AND  dn.title      = 'Deposit Request Declined'
  );
