-- Recovered from the bookofmemes-backend GitHub repo's independent migration
-- history (originally 'add_currencies_table.sql') -- that repo accumulated its own migrations
-- (numbered 002-020 + add_currencies_table) in parallel with this local
-- checkout's own 001-024, both apparently run against the same live Supabase
-- project without ever being reconciled. Renumbered here (025+) to merge both
-- histories into one record without colliding filenames -- content unchanged.

-- =============================================================
-- Migration: Add currencies reference table + exchange_rates
-- Run this in your Supabase SQL Editor (Database > SQL Editor)
-- =============================================================

-- 1. CURRENCIES REFERENCE TABLE
-- Stores the master list of all supported currencies with display metadata.
-- wallet_currencies.currency_code should reference this table.
-- =============================================================

CREATE TABLE IF NOT EXISTS currencies (
  code           CHAR(3)      PRIMARY KEY,           -- ISO 4217 code (USD, EUR, NGN …)
  name           VARCHAR(100) NOT NULL,              -- Full English name
  symbol         VARCHAR(10)  NOT NULL,              -- Display symbol ($, £, ₦ …)
  flag           VARCHAR(10)  DEFAULT '🌐',          -- Emoji flag
  decimal_places SMALLINT     NOT NULL DEFAULT 2,    -- 0 for JPY/KRW/IDR, 3 for KWD/BHD
  region         VARCHAR(20)  NOT NULL DEFAULT 'other', -- americas|europe|asia|africa|middle_east
  tier           SMALLINT     NOT NULL DEFAULT 2,    -- 1=G10/reserve, 2=standard, 3=minor
  is_active      BOOLEAN      NOT NULL DEFAULT true, -- admin can disable a currency
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Index for fast region + tier lookups (currency picker ordering)
CREATE INDEX IF NOT EXISTS idx_currencies_region_tier ON currencies (region, tier, name);

-- =============================================================
-- 2. SEED — 65 fintech-relevant currencies
-- =============================================================

INSERT INTO currencies (code, name, symbol, flag, decimal_places, region, tier) VALUES
-- Americas (tier 1)
('USD', 'US Dollar',           '$',    '🇺🇸', 2, 'americas',    1),
('CAD', 'Canadian Dollar',     'C$',   '🇨🇦', 2, 'americas',    1),
-- Americas (tier 2-3)
('BRL', 'Brazilian Real',      'R$',   '🇧🇷', 2, 'americas',    2),
('MXN', 'Mexican Peso',        'Mex$', '🇲🇽', 2, 'americas',    2),
('COP', 'Colombian Peso',      '$',    '🇨🇴', 0, 'americas',    2),
('CLP', 'Chilean Peso',        '$',    '🇨🇱', 0, 'americas',    2),
('PEN', 'Peruvian Sol',        'S/',   '🇵🇪', 2, 'americas',    2),
('ARS', 'Argentine Peso',      '$',    '🇦🇷', 2, 'americas',    2),
('DOP', 'Dominican Peso',      'RD$',  '🇩🇴', 2, 'americas',    3),
-- Europe (tier 1)
('EUR', 'Euro',                '€',   '🇪🇺', 2, 'europe',      1),
('GBP', 'British Pound',       '£',   '🇬🇧', 2, 'europe',      1),
('CHF', 'Swiss Franc',         'Fr',   '🇨🇭', 2, 'europe',      1),
-- Europe (tier 2)
('SEK', 'Swedish Krona',       'kr',   '🇸🇪', 2, 'europe',      2),
('NOK', 'Norwegian Krone',     'kr',   '🇳🇴', 2, 'europe',      2),
('DKK', 'Danish Krone',        'kr',   '🇩🇰', 2, 'europe',      2),
('PLN', 'Polish Zloty',        'zl',   '🇵🇱', 2, 'europe',      2),
('CZK', 'Czech Koruna',        'Kc',   '🇨🇿', 2, 'europe',      2),
('HUF', 'Hungarian Forint',    'Ft',   '🇭🇺', 0, 'europe',      2),
('RON', 'Romanian Leu',        'lei',  '🇷🇴', 2, 'europe',      2),
('UAH', 'Ukrainian Hryvnia',   'UAH',  '🇺🇦', 2, 'europe',      2),
('TRY', 'Turkish Lira',        'TRY',  '🇹🇷', 2, 'europe',      2),
-- Asia-Pacific (tier 1)
('JPY', 'Japanese Yen',        '¥',    '🇯🇵', 0, 'asia',        1),
('AUD', 'Australian Dollar',   'A$',   '🇦🇺', 2, 'asia',        1),
('NZD', 'New Zealand Dollar',  'NZ$',  '🇳🇿', 2, 'asia',        1),
('SGD', 'Singapore Dollar',    'S$',   '🇸🇬', 2, 'asia',        1),
('HKD', 'Hong Kong Dollar',    'HK$',  '🇭🇰', 2, 'asia',        1),
('CNY', 'Chinese Yuan',        '¥',    '🇨🇳', 2, 'asia',        1),
-- Asia-Pacific (tier 2)
('INR', 'Indian Rupee',        'Rs',   '🇮🇳', 2, 'asia',        2),
('KRW', 'South Korean Won',    'KRW',  '🇰🇷', 0, 'asia',        2),
('TWD', 'New Taiwan Dollar',   'NT$',  '🇹🇼', 2, 'asia',        2),
('MYR', 'Malaysian Ringgit',   'RM',   '🇲🇾', 2, 'asia',        2),
('IDR', 'Indonesian Rupiah',   'Rp',   '🇮🇩', 0, 'asia',        2),
('THB', 'Thai Baht',           'THB',  '🇹🇭', 2, 'asia',        2),
('PHP', 'Philippine Peso',     'PHP',  '🇵🇭', 2, 'asia',        2),
('VND', 'Vietnamese Dong',     'VND',  '🇻🇳', 0, 'asia',        2),
-- Asia-Pacific (tier 3)
('PKR', 'Pakistani Rupee',     'Rs',   '🇵🇰', 2, 'asia',        3),
('BDT', 'Bangladeshi Taka',    'BDT',  '🇧🇩', 2, 'asia',        3),
('LKR', 'Sri Lankan Rupee',    'Rs',   '🇱🇰', 2, 'asia',        3),
-- Africa (tier 2)
('NGN', 'Nigerian Naira',      'NGN',  '🇳🇬', 2, 'africa',      2),
('GHS', 'Ghanaian Cedi',       'GHS',  '🇬🇭', 2, 'africa',      2),
('KES', 'Kenyan Shilling',     'KSh',  '🇰🇪', 2, 'africa',      2),
('ZAR', 'South African Rand',  'R',    '🇿🇦', 2, 'africa',      2),
('XOF', 'West African CFA',    'CFA',  '🌍',  0, 'africa',      2),
('XAF', 'Central African CFA', 'CFA',  '🌍',  0, 'africa',      2),
('MAD', 'Moroccan Dirham',     'MAD',  '🇲🇦', 2, 'africa',      2),
-- Africa (tier 3)
('UGX', 'Ugandan Shilling',    'USh',  '🇺🇬', 0, 'africa',      3),
('TZS', 'Tanzanian Shilling',  'TSh',  '🇹🇿', 0, 'africa',      3),
('RWF', 'Rwandan Franc',       'FRw',  '🇷🇼', 0, 'africa',      3),
('ETB', 'Ethiopian Birr',      'Br',   '🇪🇹', 2, 'africa',      3),
('DZD', 'Algerian Dinar',      'DA',   '🇩🇿', 2, 'africa',      3),
('TND', 'Tunisian Dinar',      'DT',   '🇹🇳', 3, 'africa',      3),
('MZN', 'Mozambican Metical',  'MT',   '🇲🇿', 2, 'africa',      3),
('ZMW', 'Zambian Kwacha',      'ZK',   '🇿🇲', 2, 'africa',      3),
('BWP', 'Botswana Pula',       'P',    '🇧🇼', 2, 'africa',      3),
('MUR', 'Mauritian Rupee',     'Rs',   '🇲🇺', 2, 'africa',      3),
-- Middle East (tier 1)
('AED', 'UAE Dirham',          'AED',  '🇦🇪', 2, 'middle_east', 1),
('SAR', 'Saudi Riyal',         'SAR',  '🇸🇦', 2, 'middle_east', 1),
('KWD', 'Kuwaiti Dinar',       'KD',   '🇰🇼', 3, 'middle_east', 1),
-- Middle East (tier 2)
('QAR', 'Qatari Riyal',        'QR',   '🇶🇦', 2, 'middle_east', 2),
('BHD', 'Bahraini Dinar',      'BD',   '🇧🇭', 3, 'middle_east', 2),
('OMR', 'Omani Rial',          'OMR',  '🇴🇲', 3, 'middle_east', 2),
('JOD', 'Jordanian Dinar',     'JD',   '🇯🇴', 3, 'middle_east', 2),
('ILS', 'Israeli New Shekel',  'ILS',  '🇮🇱', 2, 'middle_east', 2),
('EGP', 'Egyptian Pound',      'E£',   '🇪🇬', 2, 'middle_east', 2)
ON CONFLICT (code) DO NOTHING;

-- =============================================================
-- 3. EXCHANGE RATES TABLE
-- Stores the latest known rate: 1 base_currency = rate quote_currency.
-- Updated by a backend cron or manual admin entry.
-- =============================================================

CREATE TABLE IF NOT EXISTS exchange_rates (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  base_currency   CHAR(3)      NOT NULL REFERENCES currencies(code),
  quote_currency  CHAR(3)      NOT NULL REFERENCES currencies(code),
  rate            NUMERIC(20, 8) NOT NULL,
  source          VARCHAR(50)  NOT NULL DEFAULT 'manual', -- 'manual' | 'api_fixer' | 'api_open'
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (base_currency, quote_currency)
);

CREATE INDEX IF NOT EXISTS idx_exchange_rates_base ON exchange_rates (base_currency, updated_at DESC);

-- =============================================================
-- 4. ADD FK FROM wallet_currencies.currency_code → currencies.code
-- Uses IF NOT EXISTS pattern so re-running is safe.
-- =============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'wallet_currencies_currency_code_fkey'
      AND table_name = 'wallet_currencies'
  ) THEN
    ALTER TABLE wallet_currencies
      ADD CONSTRAINT wallet_currencies_currency_code_fkey
      FOREIGN KEY (currency_code) REFERENCES currencies(code)
      ON DELETE RESTRICT;
  END IF;
END $$;

-- =============================================================
-- 5. ENABLE ROW LEVEL SECURITY on exchange_rates (read-only for all auth users)
-- =============================================================

ALTER TABLE currencies     ENABLE ROW LEVEL SECURITY;
ALTER TABLE exchange_rates ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can read currencies
CREATE POLICY IF NOT EXISTS "currencies_read_all"
  ON currencies FOR SELECT TO authenticated USING (true);

-- Any authenticated user can read rates
CREATE POLICY IF NOT EXISTS "exchange_rates_read_all"
  ON exchange_rates FOR SELECT TO authenticated USING (true);
