-- 070: Payouts by hand next to Paystack. Run after 069.
--
-- Paystack stays the automatic way to pay naira to Nigerian banks (and card
-- refunds). Next to it:
--   * Manual payout accounts ("Other: paid by an admin"): any wallet app,
--     foreign bank or service, in any currency, for users outside Nigeria.
--     The withdrawal goes to the admin queue and the admin pays it by hand,
--     then records it with Mark paid.
--   * Paystack fallback: when an automatic naira transfer fails (or is
--     reversed), the withdrawal is NOT returned to the user's balance any
--     more. It stays approved and becomes a pay-by-hand task for the admin
--     (market_withdrawal_to_manual): the user is told in the withdrawal's
--     conversation, and the admin gets a WhatsApp alert with the reason.
--   * System messages can now alert the admin on WhatsApp (support_post_event
--     p_alert), with a note only the admin sees (support_messages.wa_note).
BEGIN;

-- ── Manual payout accounts ──────────────────────────────────────────────────
ALTER TABLE public.payout_accounts
  ADD COLUMN IF NOT EXISTS manual_provider text,   -- e.g. Wise, PayPal, Chipper, bank name abroad
  ADD COLUMN IF NOT EXISTS manual_currency text,   -- currency the user wants to receive
  ADD COLUMN IF NOT EXISTS manual_details text;    -- account number / email / IBAN etc.

ALTER TABLE public.payout_accounts DROP CONSTRAINT IF EXISTS payout_accounts_method_check;
ALTER TABLE public.payout_accounts ADD CONSTRAINT payout_accounts_method_check
  CHECK (method IN ('bank_ngn', 'usdt_tron', 'usdt_bsc', 'manual'));
ALTER TABLE public.payout_accounts DROP CONSTRAINT IF EXISTS payout_accounts_check;
ALTER TABLE public.payout_accounts ADD CONSTRAINT payout_accounts_check CHECK (
  (method = 'bank_ngn' AND bank_code IS NOT NULL AND account_number ~ '^[0-9]{10}$' AND account_name IS NOT NULL)
  OR (method = 'usdt_tron' AND usdt_address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$')
  OR (method = 'usdt_bsc' AND usdt_address ~ '^0x[0-9a-fA-F]{40}$')
  OR (method = 'manual' AND account_name IS NOT NULL AND length(manual_provider) BETWEEN 2 AND 60
      AND manual_currency ~ '^[A-Z]{3}$' AND length(manual_details) BETWEEN 5 AND 500));

CREATE OR REPLACE FUNCTION public.save_manual_payout_account(
  p_user_id uuid, p_provider text, p_currency text, p_holder text, p_details text
) RETURNS payout_accounts LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row payout_accounts%ROWTYPE;
BEGIN
  IF EXISTS (SELECT 1 FROM market_withdrawals w JOIN payout_accounts a ON a.id = w.payout_account_id
             WHERE a.user_id = p_user_id AND a.method = 'manual' AND w.status IN ('pending', 'processing')) THEN
    RAISE EXCEPTION 'You can''t change this payout account while a withdrawal to it is in progress';
  END IF;
  UPDATE payout_accounts SET is_active = false WHERE user_id = p_user_id AND method = 'manual' AND is_active;
  INSERT INTO payout_accounts (user_id, method, account_name, manual_provider, manual_currency, manual_details)
    VALUES (p_user_id, 'manual', p_holder, p_provider, upper(p_currency), p_details)
    RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.save_manual_payout_account(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_manual_payout_account(uuid, text, text, text, text) TO service_role;

-- request_market_withdrawal snapshots bank/USDT fields only; add the manual
-- ones to the snapshot so the admin sees where to pay.
CREATE OR REPLACE FUNCTION public.market_withdrawal_manual_details()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb;
BEGIN
  IF NEW.payout_details ->> 'method' = 'manual' AND NEW.payout_account_id IS NOT NULL THEN
    SELECT jsonb_build_object('provider', manual_provider, 'receive_currency', manual_currency, 'details', manual_details)
      INTO v FROM payout_accounts WHERE id = NEW.payout_account_id;
    NEW.payout_details := NEW.payout_details || COALESCE(v, '{}'::jsonb);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS market_withdrawal_manual_details ON public.market_withdrawals;
CREATE TRIGGER market_withdrawal_manual_details BEFORE INSERT ON public.market_withdrawals
  FOR EACH ROW EXECUTE FUNCTION public.market_withdrawal_manual_details();

-- ── System messages that alert the admin ────────────────────────────────────
ALTER TABLE public.support_messages ADD COLUMN IF NOT EXISTS wa_note text;  -- admin's WhatsApp only, never shown to the user

CREATE OR REPLACE FUNCTION public.support_message_before()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  -- Everything the user side says is forwarded to WhatsApp, and so are system
  -- messages that ask for it (support_post_event's p_alert).
  NEW.wa_status := CASE WHEN NOT NEW.from_admin OR (NEW.automatic AND NEW.wa_status = 'pending') THEN 'pending' ELSE 'none' END;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.support_message_after()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE t support_threads%ROWTYPE;
BEGIN
  SELECT * INTO t FROM support_threads WHERE id = NEW.thread_id;
  IF NEW.from_admin THEN
    UPDATE support_threads SET
      last_message_at = NEW.created_at, last_from = 'admin', user_unread = user_unread + 1,
      -- Answering a question deals with it. Withdrawals and deposits stay
      -- open until the request itself is decided.
      status = CASE WHEN kind = 'support' AND NOT NEW.automatic THEN 'handled' ELSE status END,
      handled_at = CASE WHEN kind = 'support' AND NOT NEW.automatic THEN now() ELSE handled_at END,
      handled_by = CASE WHEN kind = 'support' AND NOT NEW.automatic THEN NEW.sender_id ELSE handled_by END
    WHERE id = NEW.thread_id;
    IF NOT NEW.automatic THEN
      PERFORM market_notify(t.user_id, 'support_reply', 'Reply from Book of Memes', left(NEW.body, 140), NEW.thread_id);
    END IF;
    IF NEW.wa_status = 'pending' THEN
      -- A system message that needs the admin: back on the to-do list, and alert now.
      UPDATE support_threads SET status = 'open', handled_at = NULL, handled_by = NULL WHERE id = NEW.thread_id;
      PERFORM support_kick_backend();
    END IF;
  ELSE
    UPDATE support_threads SET last_message_at = NEW.created_at, last_from = 'user',
      status = 'open', handled_at = NULL, handled_by = NULL
    WHERE id = NEW.thread_id;
    PERFORM support_kick_backend();
  END IF;
  RETURN NEW;
END;
$$;

-- Two extra parameters (with defaults) replace the 069 version.
DROP FUNCTION IF EXISTS public.support_post_event(uuid, text, uuid, text, text, boolean, boolean);
CREATE OR REPLACE FUNCTION public.support_post_event(
  p_user uuid, p_kind text, p_ref uuid, p_subject text, p_body text, p_from_admin boolean, p_close boolean,
  p_alert boolean DEFAULT false, p_wa_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_thread uuid;
BEGIN
  IF p_user IS NULL THEN RETURN; END IF;
  INSERT INTO support_threads (user_id, kind, subject, ref_id)
  VALUES (p_user, p_kind, left(p_subject, 120), p_ref)
  ON CONFLICT (kind, ref_id) WHERE ref_id IS NOT NULL DO UPDATE SET subject = support_threads.subject
  RETURNING id INTO v_thread;
  INSERT INTO support_messages (thread_id, sender_id, from_admin, automatic, body, wa_status, wa_note)
  VALUES (v_thread, CASE WHEN p_from_admin THEN NULL ELSE p_user END, p_from_admin, true, left(p_body, 4000),
          CASE WHEN p_alert THEN 'pending' ELSE 'none' END, left(p_wa_note, 500));
  IF p_close THEN
    UPDATE support_threads SET status = 'handled', handled_at = now() WHERE id = v_thread;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.support_post_event(uuid, text, uuid, text, text, boolean, boolean, boolean, text) FROM PUBLIC, anon, authenticated;

-- Withdrawal messages: same as 069, plus manual payout accounts.
CREATE OR REPLACE FUNCTION public.support_withdrawal_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  d jsonb := COALESCE(NEW.payout_details, '{}'::jsonb);
  v_amount text := market_money(NEW.amount, NEW.currency);
  v_subject text := 'Withdrawal ' || v_amount;
  v_to text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_to := CASE
      WHEN NEW.bucket = 'funds' THEN 'refund to where the money came from'
      WHEN d ->> 'method' = 'bank_ngn' THEN concat_ws(' · ', d ->> 'bank_name', d ->> 'account_number', d ->> 'account_name')
      WHEN d ->> 'method' LIKE 'usdt%' THEN 'USDT ' || CASE WHEN d ->> 'method' = 'usdt_tron' THEN 'TRC-20 ' ELSE 'BEP-20 ' END || COALESCE(d ->> 'usdt_address', '')
      WHEN d ->> 'method' = 'manual' THEN concat_ws(' · ', (d ->> 'provider') || ' in ' || (d ->> 'receive_currency'), d ->> 'account_name', d ->> 'details') || ' (paid by hand)'
      ELSE 'see Admin: approve withdrawals' END;
    PERFORM support_post_event(NEW.user_id, 'withdrawal', NEW.id, v_subject,
      'Withdrawal request: ' || v_amount || ' from ' || CASE WHEN NEW.bucket = 'earnings' THEN 'earnings' ELSE 'unused funds' END
        || '. Pay to: ' || v_to || '.'
        || CASE WHEN NEW.auto_created THEN ' (Created because the account is being deleted.)' ELSE '' END,
      false, false);
  ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('paid', 'rejected', 'failed') THEN
    PERFORM support_post_event(NEW.user_id, 'withdrawal', NEW.id, v_subject,
      CASE NEW.status
        WHEN 'paid' THEN 'Paid.' || COALESCE(' Reference: ' || NEW.provider_ref || '.', '')
        WHEN 'rejected' THEN 'Declined' || COALESCE(': ' || NEW.admin_note, '') || '. The money is back in your balance.'
        ELSE 'The payout could not be completed' || COALESCE(': ' || NEW.failure_reason, '') || '. The money is back in your balance.'
      END,
      true, true);
  END IF;
  RETURN NEW;
EXCEPTION WHEN others THEN
  RAISE WARNING 'support_withdrawal_event: %', SQLERRM;
  RETURN NEW;
END;
$$;

-- ── Paystack failed: the admin pays by hand ─────────────────────────────────
-- The money stays reserved (status 'processing'); nothing goes back to the
-- user's balance unless the admin chooses "Failed" later.
CREATE OR REPLACE FUNCTION public.market_withdrawal_to_manual(p_withdrawal_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE w market_withdrawals%ROWTYPE;
BEGIN
  UPDATE market_withdrawals SET provider_ref = NULL, amount_paid = NULL, currency_paid = NULL, fx_rate = NULL,
    admin_note = concat_ws(' ', admin_note, 'To do: automatic transfer failed (' || left(COALESCE(p_reason, '?'), 200)
      || '). Pay by hand to the same account, then Mark paid.')
  WHERE id = p_withdrawal_id AND status = 'processing'
  RETURNING * INTO w;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM support_post_event(w.user_id, 'withdrawal', w.id, 'Withdrawal ' || market_money(w.amount, w.currency),
    'The automatic bank transfer didn''t go through, so an admin will pay you by hand to the same account. Your money is safe; you''ll see it here when it''s paid.',
    true, false, true,
    'Paystack failed: ' || left(COALESCE(p_reason, '?'), 200) || '. Pay ' || market_money(w.amount, w.currency) || ' by hand, then Mark paid.');
  PERFORM market_notify(w.user_id, 'market_withdrawal', 'Withdrawal: paying by hand',
    'The automatic transfer didn''t go through. An admin will pay you by hand.', w.id);
END;
$$;
REVOKE ALL ON FUNCTION public.market_withdrawal_to_manual(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.market_withdrawal_to_manual(uuid, text) TO service_role;

COMMIT;
