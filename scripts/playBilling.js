// Checks (and optionally creates) the Google Play products: credit packs plus
// the ad and boost packages.
//
//   node --env-file=.env scripts/playBilling.js           check setup
//   node --env-file=.env scripts/playBilling.js --create  also create missing products
//
// Run from Backend/. Credit packs are priced at their credit amount in USD
// (credits_5 = $5.00); ad and boost packages at One Dream's exact prices
// (PLAY_AD_PRODUCTS). Google converts them to local prices.
import { createPlayAuthClient, loadPlayServiceAccount } from '../config/playAuth.js';
import { PLAY_CREDIT_PRODUCTS, PLAY_AD_PRODUCTS, PLAY_PACKAGE_NAME } from '../config/playProducts.js';

const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PLAY_PACKAGE_NAME}`;
const create = process.argv.includes('--create');

function explain(err) {
  const status = err.response?.status;
  const msg = err.response?.data?.error?.message || err.message;
  if (status === 401 || status === 403) {
    return `${msg}\n   → In Play Console → Users and permissions, invite the service account and give it access to this app ("View financial data", "Manage orders and subscriptions", and "Manage store presence" to create products). New access can take up to 24h to work.`;
  }
  if (status === 404) {
    return `${msg}\n   → The app ${PLAY_PACKAGE_NAME} isn't in this Play Console account yet, or no build with the BILLING permission has been uploaded. Upload an .aab to the Internal testing track first.`;
  }
  return msg;
}

(async () => {
  let account;
  try {
    account = loadPlayServiceAccount();
    console.log(`✔ Service account key loaded: ${account.client_email}`);
  } catch (e) {
    console.log(`✘ ${e.message}`);
    process.exit(1);
  }

  let client;
  try {
    client = await createPlayAuthClient();
    await client.getAccessToken();
    console.log('✔ Signed in to Google with the service account');
  } catch (e) {
    console.log(`✘ Could not sign in: ${e.message}\n   → Check the key file is complete and the Google Play Android Developer API is enabled in that Google Cloud project.`);
    process.exit(1);
  }

  let existing = {};
  try {
    const res = await client.request({ url: `${API}/inappproducts` });
    for (const p of res.data.inappproduct || []) existing[p.sku] = p;
    console.log(`✔ Play Console reachable for ${PLAY_PACKAGE_NAME} (${Object.keys(existing).length} in-app product(s) found)`);
  } catch (e) {
    console.log(`✘ Could not read products: ${explain(e)}`);
    process.exit(1);
  }

  let missing = 0;
  const ALL_PRODUCTS = [
    ...PLAY_CREDIT_PRODUCTS.map(({ productId, credits }) => ({
      productId,
      price: credits,
      title: `$${credits} in credits`,
      description: `$${credits} in Book of Memes credits for listing fees, boosts, ads, premium and AI tools.`,
    })),
    ...PLAY_AD_PRODUCTS,
  ];
  for (const { productId, price, title, description } of ALL_PRODUCTS) {
    const p = existing[productId];
    if (p) {
      console.log(`  ✔ ${productId}  ${p.status}  ${p.defaultPrice ? (Number(p.defaultPrice.priceMicros) / 1e6).toFixed(2) + ' ' + p.defaultPrice.currency : ''}`);
      if (p.status !== 'active') console.log('     → set it to Active in Play Console');
      continue;
    }
    if (!create) {
      console.log(`  ✘ ${productId}  missing`);
      missing += 1;
      continue;
    }
    try {
      await client.request({
        url: `${API}/inappproducts?autoConvertMissingPrices=true`,
        method: 'POST',
        data: {
          packageName: PLAY_PACKAGE_NAME,
          sku: productId,
          status: 'active',
          purchaseType: 'managedUser',
          defaultLanguage: 'en-US',
          defaultPrice: { priceMicros: String(price * 1e6), currency: 'USD' },
          listings: { 'en-US': { title, description } },
        },
      });
      console.log(`  ✔ ${productId}  created ($${price.toFixed(2)})`);
    } catch (e) {
      console.log(`  ✘ ${productId}  could not create: ${explain(e)}`);
      missing += 1;
    }
  }

  if (missing) {
    console.log(`\n${missing} product(s) still missing.${create ? ' Create them in Play Console → Monetize → Products → In-app products.' : ' Run again with --create, or create them in Play Console.'}`);
    process.exit(1);
  }
  console.log('\nGoogle Play billing is set up.');
})();
