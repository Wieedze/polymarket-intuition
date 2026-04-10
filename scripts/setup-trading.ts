/**
 * setup-trading.ts
 *
 * One-time setup: approve USDC.e and CTF tokens for Polymarket trading.
 * Must run ONCE before the bot can place any orders.
 *
 * What it does:
 *   1. Approve USDC.e → CTF contract (for splitting into outcome tokens)
 *   2. Approve USDC.e → CTF Exchange (for order settlement)
 *   3. Approve CTF tokens → CTF Exchange (for selling outcome tokens)
 *   4. Same approvals for Neg Risk Exchange (some markets use it)
 *
 * Usage:
 *   export $(cat secrets/bot-1.env | xargs) && npx tsx scripts/setup-trading.ts
 */

import { createWalletClient, createPublicClient, http, parseAbi, maxUint256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { polygon } from 'viem/chains'

// ── Polymarket contract addresses (Polygon mainnet) ──────────────
const CONTRACTS = {
  USDC_E: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as `0x${string}`,
  CTF: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as `0x${string}`,
  CTF_EXCHANGE: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E' as `0x${string}`,
  NEG_RISK_CTF_EXCHANGE: '0xC5d563A36AE78145C45a50134d48A1215220f80a' as `0x${string}`,
  NEG_RISK_ADAPTER: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296' as `0x${string}`,
}

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
])

const CTF_ABI = parseAbi([
  'function setApprovalForAll(address operator, bool approved)',
  'function isApprovedForAll(address account, address operator) view returns (bool)',
])

async function main(): Promise<void> {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY
  if (!privateKey) {
    console.error('❌ Set POLYMARKET_PRIVATE_KEY first')
    process.exit(1)
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`)
  console.log(`\n🔧 Setting up trading for: ${account.address}\n`)

  const publicClient = createPublicClient({
    chain: polygon,
    transport: http('https://polygon-rpc.com'),
  })

  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http('https://polygon-rpc.com'),
  })

  // Check USDC.e balance
  const balance = await publicClient.readContract({
    address: CONTRACTS.USDC_E,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  })
  const balanceUsdc = Number(balance) / 1e6
  console.log(`💰 USDC.e balance: $${balanceUsdc.toFixed(2)}`)

  if (balanceUsdc < 0.01) {
    console.error('❌ No USDC.e found. Bridge your USDC to USDC.e on Polygon first.')
    process.exit(1)
  }

  // Check MATIC/POL balance for gas
  const maticBalance = await publicClient.getBalance({ address: account.address })
  const maticEth = Number(maticBalance) / 1e18
  console.log(`⛽ MATIC balance: ${maticEth.toFixed(4)} MATIC`)

  if (maticEth < 0.01) {
    console.error('❌ Need MATIC for gas fees. Send at least 0.1 MATIC to this wallet.')
    process.exit(1)
  }

  console.log('')

  // ── Approval 1: USDC.e → CTF (for splitting) ──
  const allowanceCTF = await publicClient.readContract({
    address: CONTRACTS.USDC_E,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [account.address, CONTRACTS.CTF],
  })

  if (allowanceCTF === 0n) {
    console.log('📝 Approving USDC.e → CTF contract...')
    const hash = await walletClient.writeContract({
      address: CONTRACTS.USDC_E,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [CONTRACTS.CTF, maxUint256],
    })
    console.log(`   tx: ${hash}`)
    await publicClient.waitForTransactionReceipt({ hash })
    console.log('   ✅ Done')
  } else {
    console.log('✅ USDC.e → CTF already approved')
  }

  // ── Approval 2: USDC.e → CTF Exchange (for order settlement) ──
  const allowanceExchange = await publicClient.readContract({
    address: CONTRACTS.USDC_E,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [account.address, CONTRACTS.CTF_EXCHANGE],
  })

  if (allowanceExchange === 0n) {
    console.log('📝 Approving USDC.e → CTF Exchange...')
    const hash = await walletClient.writeContract({
      address: CONTRACTS.USDC_E,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [CONTRACTS.CTF_EXCHANGE, maxUint256],
    })
    console.log(`   tx: ${hash}`)
    await publicClient.waitForTransactionReceipt({ hash })
    console.log('   ✅ Done')
  } else {
    console.log('✅ USDC.e → CTF Exchange already approved')
  }

  // ── Approval 3: USDC.e → Neg Risk Exchange ──
  const allowanceNegRisk = await publicClient.readContract({
    address: CONTRACTS.USDC_E,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [account.address, CONTRACTS.NEG_RISK_CTF_EXCHANGE],
  })

  if (allowanceNegRisk === 0n) {
    console.log('📝 Approving USDC.e → Neg Risk Exchange...')
    const hash = await walletClient.writeContract({
      address: CONTRACTS.USDC_E,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [CONTRACTS.NEG_RISK_CTF_EXCHANGE, maxUint256],
    })
    console.log(`   tx: ${hash}`)
    await publicClient.waitForTransactionReceipt({ hash })
    console.log('   ✅ Done')
  } else {
    console.log('✅ USDC.e → Neg Risk Exchange already approved')
  }

  // ── Approval 4: CTF tokens → CTF Exchange (for selling outcome tokens) ──
  const ctfApprovedExchange = await publicClient.readContract({
    address: CONTRACTS.CTF,
    abi: CTF_ABI,
    functionName: 'isApprovedForAll',
    args: [account.address, CONTRACTS.CTF_EXCHANGE],
  })

  if (!ctfApprovedExchange) {
    console.log('📝 Approving CTF tokens → CTF Exchange...')
    const hash = await walletClient.writeContract({
      address: CONTRACTS.CTF,
      abi: CTF_ABI,
      functionName: 'setApprovalForAll',
      args: [CONTRACTS.CTF_EXCHANGE, true],
    })
    console.log(`   tx: ${hash}`)
    await publicClient.waitForTransactionReceipt({ hash })
    console.log('   ✅ Done')
  } else {
    console.log('✅ CTF tokens → CTF Exchange already approved')
  }

  // ── Approval 5: CTF tokens → Neg Risk Exchange ──
  const ctfApprovedNegRisk = await publicClient.readContract({
    address: CONTRACTS.CTF,
    abi: CTF_ABI,
    functionName: 'isApprovedForAll',
    args: [account.address, CONTRACTS.NEG_RISK_CTF_EXCHANGE],
  })

  if (!ctfApprovedNegRisk) {
    console.log('📝 Approving CTF tokens → Neg Risk Exchange...')
    const hash = await walletClient.writeContract({
      address: CONTRACTS.CTF,
      abi: CTF_ABI,
      functionName: 'setApprovalForAll',
      args: [CONTRACTS.NEG_RISK_CTF_EXCHANGE, true],
    })
    console.log(`   tx: ${hash}`)
    await publicClient.waitForTransactionReceipt({ hash })
    console.log('   ✅ Done')
  } else {
    console.log('✅ CTF tokens → Neg Risk Exchange already approved')
  }

  // ── Approval 6: USDC.e → Neg Risk Adapter ──
  const allowanceAdapter = await publicClient.readContract({
    address: CONTRACTS.USDC_E,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [account.address, CONTRACTS.NEG_RISK_ADAPTER],
  })

  if (allowanceAdapter === 0n) {
    console.log('📝 Approving USDC.e → Neg Risk Adapter...')
    const hash = await walletClient.writeContract({
      address: CONTRACTS.USDC_E,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [CONTRACTS.NEG_RISK_ADAPTER, maxUint256],
    })
    console.log(`   tx: ${hash}`)
    await publicClient.waitForTransactionReceipt({ hash })
    console.log('   ✅ Done')
  } else {
    console.log('✅ USDC.e → Neg Risk Adapter already approved')
  }

  console.log('\n🎉 All approvals set! Your bot is ready to trade on Polymarket.\n')
  console.log(`   Wallet: ${account.address}`)
  console.log(`   USDC.e: $${balanceUsdc.toFixed(2)}`)
  console.log(`   Gas: ${maticEth.toFixed(4)} MATIC\n`)
}

main().catch((err) => {
  console.error('❌ Fatal:', err)
  process.exit(1)
})
