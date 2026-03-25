import { getActiveWatchedWallets } from '../src/lib/db'
import { pollWallet, type PositionAlert } from '../src/lib/position-tracker'
import { keywordClassify } from '../src/lib/classifier'

// ── Alert handlers ───────────────────────────────────────────────

function formatAlert(alert: PositionAlert): string {
  const side = alert.position.outcomeIndex === 0 ? 'YES' : 'NO'
  const price = (alert.position.avgPrice * 100).toFixed(1)
  const curPrice = (alert.position.curPrice * 100).toFixed(1)
  const label = alert.walletLabel ?? alert.wallet.slice(0, 10)
  const domain = keywordClassify(alert.position.title)
  const domainTag = domain ? `[${domain.domain.replace('pm-domain/', '')}]` : ''

  switch (alert.type) {
    case 'NEW_POSITION':
      return `🟢 NEW | ${label} | ${side} @ ${price}¢ (now ${curPrice}¢) | ${alert.position.title} ${domainTag}`
    case 'POSITION_INCREASED':
      return `🔼 ADD | ${label} | ${side} @ ${price}¢ (was ${alert.previousSize?.toFixed(0)} → ${alert.position.size.toFixed(0)} shares) | ${alert.position.title} ${domainTag}`
    case 'POSITION_CLOSED':
      return `🔴 EXIT | ${label} | ${alert.position.title} ${domainTag}`
  }
}

async function consoleHandler(alert: PositionAlert): Promise<void> {
  console.log(formatAlert(alert))
}

async function webhookHandler(alert: PositionAlert): Promise<void> {
  const url = process.env.WEBHOOK_URL
  if (!url) return

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: formatAlert(alert),
        alert,
      }),
    })
  } catch (err) {
    console.error(`Webhook error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ── Main loop ────────────────────────────────────────────────────

type AlertHandler = (alert: PositionAlert) => Promise<void>

async function pollOnce(handlers: AlertHandler[]): Promise<number> {
  const wallets = getActiveWatchedWallets()
  let totalAlerts = 0

  for (const { wallet, label } of wallets) {
    try {
      const alerts = await pollWallet(wallet, label)

      for (const alert of alerts) {
        for (const handler of handlers) {
          await handler(alert)
        }
      }

      totalAlerts += alerts.length
    } catch (err) {
      console.error(`Error polling ${wallet.slice(0, 10)}: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Rate limit between wallets
    await new Promise((r) => setTimeout(r, 1000))
  }

  return totalAlerts
}

async function main(): Promise<void> {
  const intervalMs = parseInt(process.env.POLL_INTERVAL_MS ?? '300000', 10)
  const wallets = getActiveWatchedWallets()

  if (wallets.length === 0) {
    console.log('No watched wallets. Run bulk-index with --watch first:')
    console.log('  node_modules/.bin/tsx scripts/bulk-index.ts 20 MONTH --watch')
    process.exit(1)
  }

  const handlers: AlertHandler[] = [consoleHandler]
  if (process.env.WEBHOOK_URL) {
    handlers.push(webhookHandler)
    console.log(`Webhook: ${process.env.WEBHOOK_URL}`)
  }

  console.log(`\n👁️  Monitoring ${wallets.length} wallets every ${intervalMs / 1000}s`)
  console.log('Watched wallets:')
  for (const w of wallets) {
    console.log(`  ${w.wallet.slice(0, 10)}... ${w.label ?? ''}`)
  }
  console.log('\nStarting first poll...\n')

  // Initial poll
  const initialAlerts = await pollOnce(handlers)
  console.log(`\nFirst poll done: ${initialAlerts} alerts. Waiting for changes...\n`)

  // Loop
  setInterval(() => {
    const timestamp = new Date().toISOString().slice(11, 19)
    process.stdout.write(`[${timestamp}] Polling... `)
    pollOnce(handlers).then((n) => {
      console.log(`${n} alerts`)
    }).catch((err) => {
      console.error(`Poll error: ${err instanceof Error ? err.message : String(err)}`)
    })
  }, intervalMs)
}

main().catch(console.error)
