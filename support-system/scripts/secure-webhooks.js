// Run after deploying handlers for any new topics. Never prints callback keys.
require('dotenv').config({ quiet: true });
const { getEnabledStores } = require('../dist/store-service');
const { getPool } = require('../dist/pg');
const { getEffectivePublicBaseUrl } = require('../dist/email-service');
const { listWebhooks, registerWebhook, updateWebhookAddress, STORE_WEBHOOK_TOPICS } = require('../dist/shoplazza-client');
const { buildWebhookCallbackUrl, redactWebhookAddress } = require('../dist/webhook-security');

async function main() {
  const mode = process.argv[2];
  if (!['--check', '--apply'].includes(mode)) throw new Error('Usage: node scripts/secure-webhooks.js --check|--apply');
  const base = await getEffectivePublicBaseUrl();
  let verified = 0;
  for (const row of await getEnabledStores()) {
    const store = { subdomain: row.subdomain, storeName: row.store_name, accessToken: row.access_token };
    const expected = buildWebhookCallbackUrl(base, row.subdomain);
    const ownAddress = redactWebhookAddress(expected);
    const listed = await listWebhooks(store);
    if (!listed.ok) throw new Error(`${row.subdomain}: could not list subscriptions`);
    for (const topic of STORE_WEBHOOK_TOPICS) {
      const subscriptions = listed.webhooks.filter(w => w.topic === topic && redactWebhookAddress(w.address) === ownAddress);
      if (!subscriptions.length) {
        if (mode !== '--apply') throw new Error(`${row.subdomain}: missing owned subscription ${topic}`);
        const result = await registerWebhook(store, expected, topic);
        if (!result.ok) throw new Error(`${row.subdomain}: ${result.error}`);
      }
      for (const webhook of subscriptions) {
        if (webhook.address !== expected) {
          if (mode !== '--apply') throw new Error(`${row.subdomain}: callback credentials need updating`);
          const result = await updateWebhookAddress(store, webhook.id, expected, webhook.topic);
          if (!result.ok) throw new Error(`${row.subdomain}: ${result.error}`);
        }
      }
    }
    const after = await listWebhooks(store);
    if (!after.ok || STORE_WEBHOOK_TOPICS.some(topic => !after.webhooks.some(w => w.topic === topic && w.address === expected))) {
      throw new Error(`${row.subdomain}: subscription verification failed`);
    }
    verified += STORE_WEBHOOK_TOPICS.length;
    console.log(`${row.subdomain}: ${STORE_WEBHOOK_TOPICS.length} authenticated subscriptions verified`);
  }
  console.log(`Verified ${verified} subscriptions`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(() => getPool().end());
