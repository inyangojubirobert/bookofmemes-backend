// The standard deposit package ladder for wallet-link deposits (migration 060/061).
//
// Seven tiers per currency, from about US$5 up to the deposit ceiling
// (market_settings.link_deposit_max_package_usd, $500). Amounts are round
// numbers people expect in each currency, set a little under the ceiling so
// normal exchange-rate moves never push the top tier over it.
//
// This is the plan; the payment links themselves live in the database
// (market_deposit_links), because each one is created in the wallet app,
// can be switched off or replaced at any time, and must change without a new
// app release. The admin Setup screen shows this ladder with a slot per tier
// to paste each link into.
export const DEPOSIT_TIERS = {
  USD: [5, 10, 20, 50, 100, 200, 450],
  EUR: [5, 10, 20, 50, 100, 200, 400],
  GBP: [5, 10, 20, 40, 80, 150, 350],
  JPY: [1000, 2000, 3000, 7500, 15000, 30000, 65000],
  CNY: [50, 100, 150, 350, 700, 1500, 3200],
  AUD: [10, 15, 30, 75, 150, 300, 650],
  CAD: [10, 15, 30, 70, 140, 280, 600],
  CHF: [5, 10, 20, 45, 90, 180, 380],
  HKD: [50, 100, 150, 400, 800, 1500, 3500],
  SGD: [10, 15, 30, 70, 130, 270, 600],
};

export const DEPOSIT_CURRENCIES = Object.keys(DEPOSIT_TIERS);
