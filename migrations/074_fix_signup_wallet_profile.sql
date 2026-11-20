-- 074: sign-up was failing on the live database ("Database error saving new
-- user", found 2026-11-20; no profile has been created since 2025-09-11).
--
-- Cause: when Supabase creates an auth user, a trigger runs
-- handle_new_user_wallet(), which inserts the user's wallet. wallets.user_id
-- now references profiles(id), but at that moment no profile exists yet (and
-- nothing in the app creates one), so the insert fails and Supabase rejects
-- the whole sign-up.
--
-- Fix, safe whatever triggers already exist on auth.users:
--   1. handle_new_user_wallet() never fails a sign-up: it creates the wallet
--      only when the profile already exists.
--   2. A new trigger on profiles creates the wallet right after the profile is
--      inserted, so every profile gets its wallet whichever way it was made.
--   3. If no trigger on auth.users creates the profile, one is added
--      (handle_new_user_profile): username from the email (made unique), full
--      name and WhatsApp from the sign-up form's metadata. Its trigger name
--      sorts before the wallet trigger's, so it runs first.
--   4. Backfill: profiles without a wallet get one.
--
-- The NOTICE lines report what was found on auth.users, for the record.
BEGIN;

-- 1. The wallet trigger no longer blocks sign-up.
CREATE OR REPLACE FUNCTION public.handle_new_user_wallet()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_TABLE_NAME = 'profiles' OR EXISTS (SELECT 1 FROM public.profiles WHERE id = NEW.id) THEN
    INSERT INTO public.wallets (user_id, wallet_balance, token_balance)
    VALUES (NEW.id, 0, 0)
    ON CONFLICT (user_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

-- 2. Every new profile gets its wallet.
DROP TRIGGER IF EXISTS trg_profiles_create_wallet ON public.profiles;
CREATE TRIGGER trg_profiles_create_wallet AFTER INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_wallet();

-- 3. A profile for every new auth user (only if nothing else makes one).
CREATE OR REPLACE FUNCTION public.handle_new_user_profile()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_base text := lower(regexp_replace(split_part(COALESCE(NEW.email, 'user'), '@', 1), '[^a-zA-Z0-9_]', '', 'g'));
  v_meta jsonb := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb);
BEGIN
  IF v_base = '' THEN v_base := 'user'; END IF;
  INSERT INTO public.profiles (id, email, full_name, whatsapp_number, username)
  VALUES (
    NEW.id, NEW.email,
    NULLIF(v_meta->>'full_name', ''),
    NULLIF(v_meta->>'whatsapp', ''),
    left(v_base, 20) || '_' || substr(replace(NEW.id::text, '-', ''), 1, 6)
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block a sign-up over the profile; log it and let the app recover.
  RAISE WARNING 'handle_new_user_profile(%): %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DO $$
DECLARE r record; v_makes_profile boolean := false;
BEGIN
  FOR r IN
    SELECT t.tgname, p.proname, pg_get_functiondef(p.oid) AS src
    FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgrelid = 'auth.users'::regclass AND NOT t.tgisinternal
  LOOP
    RAISE NOTICE 'auth.users trigger % -> %()', r.tgname, r.proname;
    IF r.proname <> 'handle_new_user_profile' AND r.src ILIKE '%insert into%profiles%' THEN v_makes_profile := true; END IF;
  END LOOP;
  IF v_makes_profile THEN
    RAISE NOTICE 'A trigger already creates profiles; not adding another.';
    DROP TRIGGER IF EXISTS a00_create_profile ON auth.users;
  ELSE
    RAISE NOTICE 'No trigger creates profiles; adding a00_create_profile.';
    DROP TRIGGER IF EXISTS a00_create_profile ON auth.users;
    CREATE TRIGGER a00_create_profile AFTER INSERT ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_profile();
  END IF;
END $$;

-- 4. Backfill wallets.
INSERT INTO public.wallets (user_id, wallet_balance, token_balance)
SELECT p.id, 0, 0 FROM public.profiles p
WHERE NOT EXISTS (SELECT 1 FROM public.wallets w WHERE w.user_id = p.id)
ON CONFLICT (user_id) DO NOTHING;

COMMIT;
