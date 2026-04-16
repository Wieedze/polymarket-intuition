/**
 * Sync Alchemy Webhook — Creates or updates the Address Activity webhook
 *
 * Reads expert wallets from polymarket.db and syncs them to Alchemy.
 * Run once to create, then periodically to keep in sync.
 *
 * Usage:
 *   export $(cat secrets/bot-1.env | xargs) && npx tsx scripts/sync-webhook.ts
 *
 * Required env:
 *   ALCHEMY_AUTH_TOKEN     — from Alchemy dashboard (Settings → Auth Tokens)
 *   ALCHEMY_WEBHOOK_ID     — set after first run (script outputs it)
 *   SHARED_DB_PATH         — path to polymarket.db
 *
 * First run (create webhook):
 *   ALCHEMY_AUTH_TOKEN=xxx WEBHOOK_URL=http://204.168.183.197:3000/api/webhook/alchemy npx tsx scripts/sync-webhook.ts --create
 *
 * Subsequent runs (sync addresses):
 *   ALCHEMY_AUTH_TOKEN=xxx ALCHEMY_WEBHOOK_ID=wh_xxx npx tsx scripts/sync-webhook.ts
 */

import path from 'path'
import Database from 'better-sqlite3'

const ALCHEMY_API = 'https://dashboard.alchemy.com/api'
const AUTH_TOKEN = process.env.ALCHEMY_AUTH_TOKEN ?? ''
const WEBHOOK_ID = process.env.ALCHEMY_WEBHOOK_ID ?? ''
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? ''
const SHARED_DB = process.env.SHARED_DB_PATH ?? path.join(process.cwd(), 'data', 'polymarket.db')

async function getWallets(): Promise<string[]> {
  const db = new Database(SHARED_DB, { readonly: true })
  const rows = db.prepare('SELECT wallet FROM watched_wallets WHERE active = 1').all() as Array<{ wallet: string }>
  db.close()
  return rows.map(r => r.wallet.toLowerCase())
}

async function createWebhook(wallets: string[]): Promise<void> {
  if (!AUTH_TOKEN) { console.error('❌ ALCHEMY_AUTH_TOKEN required'); process.exit(1) }
  if (!WEBHOOK_URL) { console.error('❌ WEBHOOK_URL required (e.g. http://IP:3000/api/webhook/alchemy)'); process.exit(1) }

  console.log(`Creating webhook for ${wallets.length} wallets...`)
  console.log(`  URL: ${WEBHOOK_URL}`)

  const res = await fetch(`${ALCHEMY_API}/create-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Alchemy-Token': AUTH_TOKEN },
    body: JSON.stringify({
      network: 'MATIC_MAINNET',
      webhook_type: 'ADDRESS_ACTIVITY',
      webhook_url: WEBHOOK_URL,
      addresses: wallets,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    console.error(`❌ Create failed: ${res.status} ${text}`)
    process.exit(1)
  }

  const data = await res.json() as { data: { id: string; signing_key: string } }
  console.log(`\n✅ Webhook created!`)
  console.log(`  ID: ${data.data.id}`)
  console.log(`  Signing key: ${data.data.signing_key}`)
  console.log(`\nAdd to secrets/bot-1.env:`)
  console.log(`  ALCHEMY_WEBHOOK_ID=${data.data.id}`)
  console.log(`  ALCHEMY_SIGNING_KEY=${data.data.signing_key}`)
}

async function syncAddresses(wallets: string[]): Promise<void> {
  if (!AUTH_TOKEN) { console.error('❌ ALCHEMY_AUTH_TOKEN required'); process.exit(1) }
  if (!WEBHOOK_ID) { console.error('❌ ALCHEMY_WEBHOOK_ID required (run with --create first)'); process.exit(1) }

  console.log(`Syncing ${wallets.length} wallets to webhook ${WEBHOOK_ID}...`)

  const res = await fetch(`${ALCHEMY_API}/update-webhook-addresses`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Alchemy-Token': AUTH_TOKEN },
    body: JSON.stringify({
      webhook_id: WEBHOOK_ID,
      addresses: wallets,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    console.error(`❌ Sync failed: ${res.status} ${text}`)
    process.exit(1)
  }

  console.log(`✅ Synced ${wallets.length} wallets to Alchemy webhook`)
}

async function main(): Promise<void> {
  const wallets = await getWallets()
  console.log(`📋 Found ${wallets.length} active expert wallets in DB\n`)

  if (wallets.length === 0) {
    console.error('❌ No active wallets found in polymarket.db')
    process.exit(1)
  }

  const isCreate = process.argv.includes('--create')

  if (isCreate) {
    await createWebhook(wallets)
  } else {
    await syncAddresses(wallets)
  }
}

main().catch(console.error)
