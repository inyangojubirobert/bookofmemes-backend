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

export const PLAY_PRODUCT_BY_ID = Object.fromEntries(
  PLAY_CREDIT_PRODUCTS.map((p) => [p.productId, p])
);

export const PLAY_PACKAGE_NAME =
  process.env.GOOGLE_PLAY_PACKAGE_NAME || 'com.inyangojubirobert7.bookofmemes';
