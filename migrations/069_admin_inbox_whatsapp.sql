-- 069: Admin inbox with WhatsApp alerts.
--
-- Users message the admins inside the app (Profile → Message admin). They
-- never see an admin's phone number. Every message from a user, every
-- withdrawal request and every deposit a buyer says they've paid lands in the
-- admin inbox AND is forwarded to the admin's WhatsApp, so nothing waits in
-- the app unseen. Once a day the backend also sends a reminder listing
-- conversations still waiting for an answer.
--
--   support_threads    one conversation: a question, or one withdrawal / deposit
--   support_messages   the messages in it (from the user, an admin, or the system)
--   admin_alert_config the WhatsApp settings (service role only)
--
-- Sending: the backend sends every message whose wa_status is 'pending'
-- (Backend/routes/supportRoutes.js, CallMeBot). New pending messages also make
-- the database call the backend's /api/support/kick through pg_net, so the
-- alert goes out at once and a sleeping server is woken up. If that call
-- fails, the backend's one-minute sweep still sends it.
--
-- Withdrawals and link deposits post their own messages through triggers, so
-- the existing request/confirm code doesn't change. A trigger failure here
-- never blocks a money operation.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- ── WhatsApp settings (no RLS policies: service role only) ──────────────────
CREATE TABLE IF NOT EXISTS public.admin_alert_config (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL DEFAULT false,
  whatsapp_number text CHECK (whatsapp_number IS NULL OR whatsapp_number ~ '^\+[1-9][0-9]{7,14}$'),
  callmebot_apikey text,
  digest_hour smallint NOT NULL DEFAULT 8 CHECK (digest_hour BETWEEN 0 AND 23),
  timezone text NOT NULL DEFAULT 'Africa/Lagos',
  last_digest_on date,
  api_base_url text NOT NULL DEFAULT 'https://api.bookofmemes.cc',
  kick_secret text NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.admin_alert_config (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.admin_alert_config ENABLE ROW LEVEL SECURITY;

-- ── Conversations ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.support_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'support' CHECK (kind IN ('support', 'withdrawal', 'deposit')),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 120),
  ref_id uuid,                      -- market_withdrawals.id or market_payments.id
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'handled')),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  last_from text NOT NULL DEFAULT 'user' CHECK (last_from IN ('user', 'admin')),
  user_unread integer NOT NULL DEFAULT 0,
  handled_at timestamptz,
  handled_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS support_threads_ref_uidx ON public.support_threads (kind, ref_id) WHERE ref_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS support_threads_status_idx ON public.support_threads (status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS support_threads_user_idx ON public.support_threads (user_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS public.support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES public.support_threads(id) ON DELETE CASCADE,
  sender_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  from_admin boolean NOT NULL DEFAULT false,
  automatic boolean NOT NULL DEFAULT false,   -- written by the system, not typed
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  image_url text CHECK (image_url IS NULL OR image_url ~ '^https://'),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- WhatsApp forwarding (user-side messages only)
  wa_status text NOT NULL DEFAULT 'none' CHECK (wa_status IN ('none', 'pending', 'sent', 'failed')),
  wa_attempts integer NOT NULL DEFAULT 0,
  wa_next_try_at timestamptz,
  wa_sent_at timestamptz,
  wa_error text
);
CREATE INDEX IF NOT EXISTS support_messages_thread_idx ON public.support_messages (thread_id, created_at);
CREATE INDEX IF NOT EXISTS support_messages_wa_pending_idx ON public.support_messages (created_at) WHERE wa_status = 'pending';

-- Users can read their own conversations; every write goes through the backend.
ALTER TABLE public.support_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS support_threads_own ON public.support_threads;
CREATE POLICY support_threads_own ON public.support_threads FOR SELECT USING (user_id = auth.uid() OR is_app_admin());
DROP POLICY IF EXISTS support_messages_own ON public.support_messages;
CREATE POLICY support_messages_own ON public.support_messages FOR SELECT USING (
  EXISTS (SELECT 1 FROM support_threads t WHERE t.id = thread_id AND (t.user_id = auth.uid() OR is_app_admin())));

-- ── Wake the backend so a new alert goes out now ────────────────────────────
CREATE OR REPLACE FUNCTION public.support_kick_backend()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE c admin_alert_config%ROWTYPE;
BEGIN
  SELECT * INTO c FROM admin_alert_config WHERE id;
  IF NOT FOUND OR NOT c.enabled THEN RETURN; END IF;
  PERFORM net.http_post(
    url := rtrim(c.api_base_url, '/') || '/api/support/kick',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-kick-secret', c.kick_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);
EXCEPTION WHEN others THEN
  NULL;  -- the backend's sweep sends it anyway
END;
$$;
REVOKE ALL ON FUNCTION public.support_kick_backend() FROM PUBLIC, anon, authenticated;

-- ── Message bookkeeping ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.support_message_before()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  -- Everything the user side says is forwarded to WhatsApp.
  NEW.wa_status := CASE WHEN NEW.from_admin THEN 'none' ELSE 'pending' END;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS support_message_before ON public.support_messages;
CREATE TRIGGER support_message_before BEFORE INSERT ON public.support_messages
  FOR EACH ROW EXECUTE FUNCTION public.support_message_before();

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
  ELSE
    UPDATE support_threads SET last_message_at = NEW.created_at, last_from = 'user',
      status = 'open', handled_at = NULL, handled_by = NULL
    WHERE id = NEW.thread_id;
    PERFORM support_kick_backend();
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS support_message_after ON public.support_messages;
CREATE TRIGGER support_message_after AFTER INSERT ON public.support_messages
  FOR EACH ROW EXECUTE FUNCTION public.support_message_after();

-- ── System messages for withdrawals and deposits ────────────────────────────
-- Finds or opens the request's conversation and posts one message in it.
-- p_close marks the conversation handled (the request was decided).
CREATE OR REPLACE FUNCTION public.support_post_event(
  p_user uuid, p_kind text, p_ref uuid, p_subject text, p_body text, p_from_admin boolean, p_close boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_thread uuid;
BEGIN
  IF p_user IS NULL THEN RETURN; END IF;
  INSERT INTO support_threads (user_id, kind, subject, ref_id)
  VALUES (p_user, p_kind, left(p_subject, 120), p_ref)
  ON CONFLICT (kind, ref_id) WHERE ref_id IS NOT NULL DO UPDATE SET subject = support_threads.subject
  RETURNING id INTO v_thread;
  INSERT INTO support_messages (thread_id, sender_id, from_admin, automatic, body)
  VALUES (v_thread, CASE WHEN p_from_admin THEN NULL ELSE p_user END, p_from_admin, true, left(p_body, 4000));
  IF p_close THEN
    UPDATE support_threads SET status = 'handled', handled_at = now() WHERE id = v_thread;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.support_post_event(uuid, text, uuid, text, text, boolean, boolean) FROM PUBLIC, anon, authenticated;

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
DROP TRIGGER IF EXISTS support_withdrawal_event ON public.market_withdrawals;
CREATE TRIGGER support_withdrawal_event AFTER INSERT OR UPDATE OF status ON public.market_withdrawals
  FOR EACH ROW EXECUTE FUNCTION public.support_withdrawal_event();

CREATE OR REPLACE FUNCTION public.support_deposit_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_subject text;
BEGIN
  IF NEW.method <> 'wallet_link' OR NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  v_subject := 'Deposit ' || COALESCE(NEW.deposit_code, '') || ' · ' || market_money(NEW.amount_due, NEW.pay_currency);
  IF NEW.status = 'submitted' THEN
    PERFORM support_post_event(NEW.user_id, 'deposit', NEW.id, v_subject,
      'I have paid deposit ' || COALESCE(NEW.deposit_code, '') || ': ' || market_money(NEW.amount_due, NEW.pay_currency)
        || ' through ' || COALESCE(NEW.deposit_provider, 'the wallet app')
        || ' from ' || COALESCE(NEW.payer_name, '?') || ', transaction ID ' || COALESCE(NEW.payer_tx_ref, '?')
        || '. It adds ' || market_money(NEW.credit_amount, 'USD') || ' to my funds.'
        || CASE WHEN NEW.credit_amount >= (SELECT link_deposit_large_usd FROM market_settings WHERE id) THEN ' (Large deposit: an admin must confirm.)' ELSE '' END,
      false, false);
  ELSIF NEW.status = 'paid' AND OLD.status = 'submitted' THEN
    PERFORM support_post_event(NEW.user_id, 'deposit', NEW.id, v_subject,
      'Confirmed. ' || market_money(NEW.credit_amount, 'USD') || ' was added to your marketplace funds.', true, true);
  ELSIF NEW.status = 'failed' AND OLD.status = 'submitted' THEN
    PERFORM support_post_event(NEW.user_id, 'deposit', NEW.id, v_subject,
      'We could not confirm this payment' || COALESCE(': ' || NEW.review_note, '') || '. Reply here if you think this is wrong.', true, true);
  END IF;
  RETURN NEW;
EXCEPTION WHEN others THEN
  RAISE WARNING 'support_deposit_event: %', SQLERRM;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS support_deposit_event ON public.market_payments;
CREATE TRIGGER support_deposit_event AFTER UPDATE OF status ON public.market_payments
  FOR EACH ROW EXECUTE FUNCTION public.support_deposit_event();

COMMIT;
