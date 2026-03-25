'use client'

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import SearchBar from '../components/SearchBar'

export default function Home(): React.ReactElement {
  const router = useRouter()

  function handleSearch(address: string): void {
    router.push(`/profile/${address}`)
  }

  return (
    <main className="flex flex-col items-center justify-center min-h-screen px-4">
      {/* Nav */}
      <nav className="fixed top-0 right-0 p-4 flex gap-2">
        <Link
          href="/leaderboard"
          className="px-4 py-2 text-sm text-zinc-400 hover:text-white border border-zinc-700 hover:border-zinc-500 rounded-lg transition-colors"
        >
          Leaderboard
        </Link>
        <Link
          href="/monitor"
          className="px-4 py-2 text-sm text-zinc-400 hover:text-white border border-zinc-700 hover:border-zinc-500 rounded-lg transition-colors"
        >
          Monitor
        </Link>
        <Link
          href="/signal"
          className="px-4 py-2 text-sm text-zinc-400 hover:text-white border border-zinc-700 hover:border-zinc-500 rounded-lg transition-colors"
        >
          Signal
        </Link>
      </nav>

      <div className="text-center mb-12">
        <h1 className="text-5xl font-bold text-white tracking-tight">
          Proof of Prediction
        </h1>
        <p className="mt-4 text-lg text-zinc-400 max-w-md mx-auto">
          Verifiable reputation for prediction market traders.
          Powered by Polymarket &amp; Intuition.
        </p>
      </div>

      <SearchBar onSearch={handleSearch} />

      <div className="mt-16 text-center text-zinc-600 text-sm max-w-lg">
        <p>
          Enter any wallet address to see their prediction track record,
          calibration scores, and on-chain attestations across domains.
        </p>
      </div>
    </main>
  )
}
