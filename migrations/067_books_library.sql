-- 067: Books Library, a new content type: books written page by page, where
-- every page can carry text, an illustration, or both (illustrated books).
--
--   books_library  the book (title, description, pen name, genre, cover)
--   book_pages     its pages in order: heading, text, image, caption
--
-- Wired in like the other content types: item_type_enum, universal_items,
-- search_index sync, read/write rules (authors manage their own books; anyone
-- can read published ones), marketplace listing + content locks (a listed or
-- sold book's pages can't change), account deletion, and ad boosts.
-- create_marketplace_listing, finalize_account_deletion and ads_post_owner are
-- the latest versions (057/058) with 'books_library' added to their type lists.

ALTER TYPE public.item_type_enum ADD VALUE IF NOT EXISTS 'books_library';

BEGIN;

INSERT INTO public.universal_items (item_type, description)
SELECT 'books_library', 'Books: illustrated and text books, page by page'
WHERE NOT EXISTS (SELECT 1 FROM public.universal_items WHERE item_type = 'books_library');

CREATE TABLE IF NOT EXISTS public.books_library (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  universal_item_type text NOT NULL DEFAULT 'books_library' REFERENCES public.universal_items(item_type) ON UPDATE CASCADE,
  author_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 160),
  description text CHECK (description IS NULL OR char_length(description) <= 4000),
  author_name text CHECK (author_name IS NULL OR char_length(author_name) <= 120), -- pen name shown on the cover
  genre text,
  language text,
  cover_image_url text,
  page_count integer NOT NULL DEFAULT 0,
  is_published boolean NOT NULL DEFAULT true,
  is_premium boolean NOT NULL DEFAULT false,
  tags text[] NOT NULL DEFAULT '{}',
  read_count integer NOT NULL DEFAULT 0,
  like_count integer NOT NULL DEFAULT 0,
  bookmarks_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_books_library_author ON public.books_library (author_id);
CREATE INDEX IF NOT EXISTS idx_books_library_published ON public.books_library (is_published, read_count DESC);

CREATE TABLE IF NOT EXISTS public.book_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES public.books_library(id) ON DELETE CASCADE,
  author_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  page_number integer NOT NULL CHECK (page_number >= 1),
  heading text CHECK (heading IS NULL OR char_length(heading) <= 200),
  content text CHECK (content IS NULL OR char_length(content) <= 20000),
  image_url text,
  image_caption text CHECK (image_caption IS NULL OR char_length(image_caption) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (book_id, page_number),
  CHECK (coalesce(nullif(trim(content), ''), image_url) IS NOT NULL) -- a page has text, a picture, or both
);
CREATE INDEX IF NOT EXISTS idx_book_pages_book ON public.book_pages (book_id, page_number);

-- ── Read/write rules ────────────────────────────────────────────────────────
ALTER TABLE public.books_library ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.book_pages ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.books_library, public.book_pages TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.books_library, public.book_pages TO authenticated;
GRANT ALL ON public.books_library, public.book_pages TO service_role;

DROP POLICY IF EXISTS books_read ON public.books_library;
CREATE POLICY books_read ON public.books_library FOR SELECT USING (is_published OR auth.uid() = author_id);
DROP POLICY IF EXISTS books_insert ON public.books_library;
CREATE POLICY books_insert ON public.books_library FOR INSERT WITH CHECK (auth.uid() = author_id);
DROP POLICY IF EXISTS books_update ON public.books_library;
CREATE POLICY books_update ON public.books_library FOR UPDATE USING (auth.uid() = author_id) WITH CHECK (auth.uid() = author_id);
DROP POLICY IF EXISTS books_delete ON public.books_library;
CREATE POLICY books_delete ON public.books_library FOR DELETE USING (auth.uid() = author_id);

DROP POLICY IF EXISTS book_pages_read ON public.book_pages;
CREATE POLICY book_pages_read ON public.book_pages FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.books_library b WHERE b.id = book_id AND (b.is_published OR b.author_id = auth.uid())));
DROP POLICY IF EXISTS book_pages_write ON public.book_pages;
CREATE POLICY book_pages_write ON public.book_pages FOR ALL
  USING (EXISTS (SELECT 1 FROM public.books_library b WHERE b.id = book_id AND b.author_id = auth.uid()))
  WITH CHECK (author_id = auth.uid() AND EXISTS (SELECT 1 FROM public.books_library b WHERE b.id = book_id AND b.author_id = auth.uid()));

-- ── Page count kept on the book ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.book_pages_count()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_book uuid := COALESCE(NEW.book_id, OLD.book_id);
BEGIN
  UPDATE books_library SET page_count = (SELECT count(*) FROM book_pages WHERE book_id = v_book) WHERE id = v_book;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_book_pages_count ON public.book_pages;
CREATE TRIGGER trg_book_pages_count AFTER INSERT OR DELETE ON public.book_pages
  FOR EACH ROW EXECUTE FUNCTION public.book_pages_count();

-- ── Search ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_sync_books_library_to_search()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO search_index (item_id, item_type, author_id, title, description, thumbnail_url, tags, is_premium, is_published,
                            view_count, like_count, metadata, created_at)
  VALUES (NEW.id, NEW.universal_item_type, NEW.author_id, NEW.title, NEW.description, NEW.cover_image_url,
          COALESCE(NEW.tags, '{}'), NEW.is_premium, NEW.is_published, COALESCE(NEW.read_count, 0), COALESCE(NEW.like_count, 0),
          jsonb_build_object('genre', NEW.genre, 'author_name', NEW.author_name, 'pages', NEW.page_count), COALESCE(NEW.created_at, now()))
  ON CONFLICT (item_id, item_type) DO UPDATE SET
    title = EXCLUDED.title, description = EXCLUDED.description, thumbnail_url = EXCLUDED.thumbnail_url, tags = EXCLUDED.tags,
    is_premium = EXCLUDED.is_premium, is_published = EXCLUDED.is_published, view_count = EXCLUDED.view_count,
    like_count = EXCLUDED.like_count, metadata = EXCLUDED.metadata, updated_at = now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_books_library_search_sync ON public.books_library;
CREATE TRIGGER trg_books_library_search_sync AFTER INSERT OR UPDATE ON public.books_library
  FOR EACH ROW EXECUTE FUNCTION public.fn_sync_books_library_to_search();

-- ── Marketplace: a listed or sold book is frozen, pages included ────────────
DROP TRIGGER IF EXISTS trg_guard_market_content ON public.books_library;
CREATE TRIGGER trg_guard_market_content BEFORE UPDATE OR DELETE ON public.books_library
  FOR EACH ROW EXECUTE FUNCTION public.guard_market_content();

CREATE OR REPLACE FUNCTION public.guard_market_book_page()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF COALESCE(current_setting('app.content_admin_override', true), '') = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF market_item_locked('books_library', COALESCE(NEW.book_id, OLD.book_id)) IS NOT NULL THEN
    RAISE EXCEPTION 'This book is on the marketplace or owned by a buyer, so its pages can''t be changed.';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_market_book_page ON public.book_pages;
CREATE TRIGGER trg_guard_market_book_page BEFORE INSERT OR UPDATE OR DELETE ON public.book_pages
  FOR EACH ROW EXECUTE FUNCTION public.guard_market_book_page();

-- ── Story Studio can publish a project as a book (pages with illustrations) ─
ALTER TABLE public.story_projects
  ADD COLUMN IF NOT EXISTS publish_as text NOT NULL DEFAULT 'stories' CHECK (publish_as IN ('stories', 'books_library')),
  ADD COLUMN IF NOT EXISTS book_id uuid REFERENCES public.books_library(id) ON DELETE SET NULL;
ALTER TABLE public.story_project_chapters
  ADD COLUMN IF NOT EXISTS image_url text,
  ADD COLUMN IF NOT EXISTS book_page_id uuid REFERENCES public.book_pages(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public.create_marketplace_listing(
  p_item_type text, p_item_id uuid, p_seller_id uuid, p_asking_price numeric,
  p_buy_now_price numeric DEFAULT NULL, p_reserve_price numeric DEFAULT NULL, p_minimum_increment numeric DEFAULT NULL,
  p_royalty_pct numeric DEFAULT NULL, p_expires_at timestamptz DEFAULT NULL, p_listing_type text DEFAULT NULL,
  p_listing_currency text DEFAULT 'USD'
)
 RETURNS marketplace_listings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  s market_settings%ROWTYPE;
  v_cur marketplace_currencies%ROWTYPE;
  v_listing_fee numeric := 0.50;
  v_author_id uuid;
  v_current_owner uuid;
  v_wallet wallets%ROWTYPE;
  v_listing marketplace_listings%ROWTYPE;
  v_listing_type text;
  v_buy_now_price numeric;
  v_royalty_pct numeric;
  v_increment numeric;
  v_expires timestamptz;
  v_max_days integer;
  v_min_price numeric;
BEGIN
  SELECT * INTO s FROM market_settings WHERE id;
  IF p_seller_id IS NULL OR p_seller_id <> auth.uid() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF EXISTS (SELECT 1 FROM account_deletion_requests WHERE user_id = p_seller_id AND status = 'pending') THEN
    RAISE EXCEPTION 'This account is being deleted';
  END IF;
  IF p_item_type NOT IN ('stories', 'memes', 'puzzles', 'kids_collections', 'music_box', 'podcast_box', 'tv_box', 'books_library') THEN
    RAISE EXCEPTION 'Invalid item_type: %', p_item_type;
  END IF;

  SELECT * INTO v_cur FROM marketplace_currencies WHERE code = COALESCE(p_listing_currency, 'USD') AND is_enabled;
  IF NOT FOUND THEN RAISE EXCEPTION 'That currency isn''t available for listings'; END IF;

  -- Minimum price: the equivalent of $1 (needs a fresh rate for non-USD).
  v_min_price := market_convert(1, 'USD', v_cur.code);
  IF p_asking_price IS NULL OR p_asking_price < v_min_price THEN
    RAISE EXCEPTION 'Starting price must be at least %', market_money(v_min_price, v_cur.code);
  END IF;
  IF p_reserve_price IS NOT NULL AND p_reserve_price < 0 THEN
    RAISE EXCEPTION 'reserve_price cannot be negative';
  END IF;
  v_increment := COALESCE(p_minimum_increment, v_min_price);
  IF v_increment <= 0 THEN
    RAISE EXCEPTION 'minimum_increment must be greater than 0';
  END IF;

  v_listing_type := COALESCE(p_listing_type, CASE WHEN p_buy_now_price IS NOT NULL THEN 'auction_buy_now' ELSE 'auction' END);
  IF v_listing_type NOT IN ('auction', 'auction_buy_now', 'fixed_price') THEN
    RAISE EXCEPTION 'Invalid listing_type: %', v_listing_type;
  END IF;

  v_buy_now_price := p_buy_now_price;
  IF v_listing_type = 'fixed_price' THEN
    v_buy_now_price := COALESCE(v_buy_now_price, p_asking_price);
  END IF;
  IF v_listing_type = 'auction' AND v_buy_now_price IS NOT NULL THEN
    RAISE EXCEPTION 'An auction listing (no instant purchase) cannot have a buy_now_price -- use auction_buy_now instead';
  END IF;
  IF v_listing_type IN ('auction_buy_now', 'fixed_price') AND (v_buy_now_price IS NULL OR v_buy_now_price < v_min_price) THEN
    RAISE EXCEPTION 'buy_now_price is required for listing_type %', v_listing_type;
  END IF;
  IF v_listing_type = 'auction_buy_now' AND v_buy_now_price < p_asking_price THEN
    RAISE EXCEPTION 'Buy Now price can''t be below the starting bid';
  END IF;

  -- Every listing ends.
  v_max_days := CASE WHEN v_listing_type = 'fixed_price' THEN s.fixed_max_days ELSE s.auction_max_days END;
  v_expires := COALESCE(p_expires_at, now() + make_interval(days => s.auction_default_days));
  IF v_expires < now() + interval '1 hour' OR v_expires > now() + make_interval(days => v_max_days) THEN
    RAISE EXCEPTION 'A listing must run between 1 hour and % days', v_max_days;
  END IF;

  EXECUTE format('SELECT author_id FROM %I WHERE id = $1', p_item_type) INTO v_author_id USING p_item_id;
  IF v_author_id IS NULL THEN
    RAISE EXCEPTION 'Item not found';
  END IF;

  SELECT to_user_id INTO v_current_owner FROM marketplace_ownership_history
    WHERE item_type = p_item_type AND item_id = p_item_id
    ORDER BY transferred_at DESC LIMIT 1;
  IF NOT FOUND THEN
    v_current_owner := v_author_id;
  END IF;
  IF v_current_owner IS NULL OR v_current_owner <> p_seller_id THEN
    RAISE EXCEPTION 'You do not own this item';
  END IF;

  -- Royalty: the creator chooses it while they still own the item; once it
  -- has sold, the rate locked in at the first sale applies to every resale.
  IF p_seller_id = v_author_id AND NOT EXISTS (
    SELECT 1 FROM marketplace_ownership_history WHERE item_type = p_item_type AND item_id = p_item_id
  ) THEN
    v_royalty_pct := COALESCE(p_royalty_pct, s.royalty_default_pct);
    IF v_royalty_pct < 0 OR v_royalty_pct > s.royalty_max_pct THEN
      RAISE EXCEPTION 'Royalty must be between 0%% and %', s.royalty_max_pct || '%';
    END IF;
  ELSE
    SELECT l.royalty_pct INTO v_royalty_pct
      FROM marketplace_ownership_history h
      JOIN marketplace_listings l ON l.id = h.listing_id
      WHERE h.item_type = p_item_type AND h.item_id = p_item_id
      ORDER BY h.transferred_at ASC LIMIT 1;
    v_royalty_pct := LEAST(GREATEST(COALESCE(v_royalty_pct, s.royalty_default_pct), 0), s.royalty_max_pct);
  END IF;

  PERFORM ensure_wallet(p_seller_id);
  SELECT * INTO v_wallet FROM wallets WHERE user_id = p_seller_id FOR UPDATE;
  IF wallet_available_balance(v_wallet.id) < v_listing_fee THEN
    RAISE EXCEPTION 'Insufficient credits for the listing fee ($% required)', v_listing_fee;
  END IF;

  INSERT INTO marketplace_listings (
    item_type, item_id, seller_id, creator_id, asking_price, buy_now_price,
    reserve_price, minimum_increment, royalty_pct, expires_at, listing_fee_paid, listing_type, listing_currency
  ) VALUES (
    p_item_type, p_item_id, p_seller_id, v_author_id, ROUND(p_asking_price, 2), ROUND(v_buy_now_price, 2),
    ROUND(p_reserve_price, 2), v_increment, v_royalty_pct, v_expires, v_listing_fee, v_listing_type, v_cur.code
  ) RETURNING * INTO v_listing;

  UPDATE wallets SET wallet_balance = wallet_balance - v_listing_fee, updated_at = now()
    WHERE id = v_wallet.id;
  INSERT INTO wallet_ledger (wallet_id, transaction_type, debit, credit, balance_before, balance_after, reference_id)
    VALUES (v_wallet.id, 'marketplace_listing_fee', v_listing_fee, 0,
            v_wallet.wallet_balance, v_wallet.wallet_balance - v_listing_fee, v_listing.id);
  INSERT INTO wallet_transactions (wallet_id, type, amount, description, status, currency_code, metadata)
    VALUES (v_wallet.id, 'marketplace_listing_fee', -v_listing_fee, 'Marketplace listing fee', 'completed', 'USD',
            jsonb_build_object('listing_id', v_listing.id, 'item_type', v_listing.item_type, 'item_id', v_listing.item_id));

  PERFORM record_revenue(
    p_source => 'marketplace_listing', p_user_id => p_seller_id, p_reference_id => v_listing.id,
    p_gross_amount => v_listing_fee, p_revenue_amount => v_listing_fee, p_currency => 'USD',
    p_payment_method => 'wallet', p_original_currency => 'USD', p_original_amount => v_listing_fee,
    p_metadata => jsonb_build_object('item_type', v_listing.item_type, 'item_id', v_listing.item_id)
  );

  RETURN v_listing;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.create_marketplace_listing(text, uuid, uuid, numeric, numeric, numeric, numeric, numeric, timestamptz, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.finalize_account_deletion(p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM account_deletion_requests WHERE user_id = p_user_id AND status = 'pending') THEN
    RAISE EXCEPTION 'No pending deletion request';
  END IF;
  FOREACH t IN ARRAY ARRAY['stories','memes','puzzles','kids_collections','music_box','podcast_box','tv_box','books_library'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format(
        'DELETE FROM public.%I c WHERE c.author_id = $1
           AND NOT EXISTS (SELECT 1 FROM marketplace_ownership_history h WHERE h.item_type = %L AND h.item_id = c.id)
           AND NOT EXISTS (SELECT 1 FROM marketplace_listings l WHERE l.item_type = %L AND l.item_id = c.id
                           AND l.status IN (''active'',''awaiting_decision''))', t, t, t)
        USING p_user_id;
    END IF;
  END LOOP;
  UPDATE account_deletion_requests SET status = 'completed', completed_at = now() WHERE user_id = p_user_id;
END;
$$;
REVOKE ALL ON FUNCTION public.finalize_account_deletion(uuid) FROM PUBLIC, anon, authenticated;

-- ── Ads: books can be boosted ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ads_post_owner(p_item_type text, p_item_id uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  v_owner uuid;
  v_author uuid;
BEGIN
  IF p_item_type NOT IN ('stories', 'memes', 'puzzles', 'kids_collections', 'music_box', 'podcast_box', 'tv_box', 'books_library') THEN
    RETURN NULL;
  END IF;
  SELECT to_user_id INTO v_owner FROM marketplace_ownership_history
   WHERE item_type = p_item_type AND item_id = p_item_id ORDER BY transferred_at DESC LIMIT 1;
  IF FOUND THEN RETURN v_owner; END IF;
  EXECUTE format('SELECT author_id FROM %I WHERE id = $1', p_item_type) INTO v_author USING p_item_id;
  RETURN v_author;
END;
$$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.advertising_campaigns'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) ILIKE '%tv_box%' LOOP
    EXECUTE format('ALTER TABLE public.advertising_campaigns DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE public.advertising_campaigns ADD CONSTRAINT advertising_campaigns_item_type_check
  CHECK (item_type IS NULL OR item_type IN ('stories', 'memes', 'puzzles', 'kids_collections', 'music_box', 'podcast_box', 'tv_box', 'books_library'));

COMMIT;
