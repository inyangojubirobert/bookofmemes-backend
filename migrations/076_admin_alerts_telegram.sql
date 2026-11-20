-- 076: admin alerts can go to Telegram instead of WhatsApp.
-- CallMeBot (the free WhatsApp route in 069) never answered the activation
-- message, so alerts couldn't be switched on. A Telegram bot is free,
-- official and instant. The admin chooses the channel in the app; the
-- existing queue, retries and daily reminder work the same for both.
BEGIN;
ALTER TABLE public.admin_alert_config
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'whatsapp',
  ADD COLUMN IF NOT EXISTS telegram_bot_token text,
  ADD COLUMN IF NOT EXISTS telegram_chat_id text,
  ADD COLUMN IF NOT EXISTS telegram_bot_username text;
DO $$ BEGIN
  ALTER TABLE public.admin_alert_config ADD CONSTRAINT admin_alert_config_channel_check CHECK (channel IN ('whatsapp', 'telegram'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
COMMIT;
