// Google Play Billing products (all consumable "in-app" products).
//
// Each product must be created in Play Console → Monetize → In-app products
// with exactly this product ID, and set to Active. The price is set in Play
// Console (Google localizes it per country). `credits` is what the buyer's
// in-app wallet balance goes up by, in the app's USD-valued credits.
//
// Credits are closed-loop: they pay for things the platform sells (marketplace
// listing fee and featured upgrade, post boosts and ads from ad_packages,
// premium, AI). They can't be cashed out, sent to another user, or used to buy
// other users' content on the marketplace (that uses real money: migration 055).
//
// The range covers every ad package price (One Dream's ladder: boosts $3-$25,
// ads $10-$400) so a buyer can always top up the exact amount. $400 is the
// highest price Google Play accepts for a single in-app product.
const CREDIT_AMOUNTS = [1, 2, 3, 5, 10, 15, 20, 25, 40, 50, 75, 100, 150, 200, 250, 300, 400];
export const PLAY_CREDIT_PRODUCTS = CREDIT_AMOUNTS.map((credits) => ({ productId: `credits_${credits}`, credits }));

// Ad and boost packages (migration 058): one Google Play product each, priced
// exactly as One Dream. Must match advertising_packages.google_play_product_id.
// Google Play's limit is $400 per product, so the $1,500 and $4,000 boost
// tiers aren't sold in the app.
export const PLAY_AD_PRODUCTS = [
  { productId: 'bom_ad_starter',    price: 10,  title: 'Starter Ads',   description: '3 days of sponsored placements, 1 image or video.' },
  { productId: 'bom_ad_growth',     price: 20,  title: 'Growth Ads',    description: '7 days on home and discovery, 2 creatives.' },
  { productId: 'bom_ad_premium',    price: 40,  title: 'Premium Ads',   description: '15 days in premium placements, 3 creatives.' },
  { productId: 'bom_ad_business',   price: 75,  title: 'Business Ads',  description: '30 days across all placements, 5 creatives.' },
  { productId: 'bom_ad_bronze',     price: 100, title: 'Bronze Ads',    description: '30 days, 6 creatives, more exposure than Business.' },
  { productId: 'bom_ad_silver',     price: 200, title: 'Silver Ads',    description: '30 days, 7 creatives, more exposure than Bronze.' },
  { productId: 'bom_ad_gold',       price: 400, title: 'Gold Ads',      description: '30 days, 8 creatives, the most ad exposure.' },
  { productId: 'bom_boost_quick',   price: 3,   title: 'Quick Boost',   description: '24 hours of extra visibility for one of your posts.' },
  { productId: 'bom_boost_creator', price: 10,  title: 'Creator Boost', description: '7 days of extra visibility for one of your posts.' },
  { productId: 'bom_boost_power',   price: 25,  title: 'Power Boost',   description: '30 days of high visibility for one of your posts.' },
  { productId: 'bom_boost_pro',     price: 100, title: 'Pro Boost',     description: '30 days near the top for one of your posts.' },
  { productId: 'bom_boost_prime',   price: 200, title: 'Prime Boost',   description: '30 days of stronger placement for one of your posts.' },
  { productId: 'bom_boost_star',    price: 300, title: 'Star Boost',    description: '30 days of standout placement for one of your posts.' },
  { productId: 'bom_boost_elite',   price: 400, title: 'Elite Boost',   description: '30 days of premium placement for one of your posts.' },
];

export const PLAY_PRODUCT_BY_ID = Object.fromEntries(
  PLAY_CREDIT_PRODUCTS.map((p) => [p.productId, p])
);

export const PLAY_PACKAGE_NAME =
  process.env.GOOGLE_PLAY_PACKAGE_NAME || 'com.bookofmemes.app';
