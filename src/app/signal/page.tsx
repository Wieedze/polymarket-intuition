'use client'

import { useState } from 'react'
import Link from 'next/link'

type ExpertInfo = {
  address: string
  calibration: number
  convictionScore: number
  trades: number
  avgPosition: number
}

type SignalData = {
  question: string
  domain: string | null
  expertsFound: number
  aggregatedSignal: number
  signalStrength: 'strong' | 'moderate' | 'weak'
  experts: ExpertInfo[]
}

const DOMAIN_LABELS: Record<string, string> = {
  'pm-domain/ai-tech': 'AI & Tech',
  'pm-domain/politics': 'Politics',
  'pm-domain/crypto': 'Crypto',
  'pm-domain/sports': 'Sports',
  'pm-domain/economics': 'Economics',
  'pm-domain/science': 'Science',
  'pm-domain/culture': 'Culture',
  'pm-domain/weather': 'Weather',
  'pm-domain/geopolitics': 'Geopolitics',
}

const DOMAIN_COLORS: Record<string, string> = {
  'pm-domain/ai-tech': 'bg-violet-500/20 text-violet-400 border-violet-500/30',
  'pm-domain/politics': 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  'pm-domain/crypto': 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  'pm-domain/sports': 'bg-green-500/20 text-green-400 border-green-500/30',
  'pm-domain/economics': 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  'pm-domain/science': 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
  'pm-domain/culture': 'bg-pink-500/20 text-pink-400 border-pink-500/30',
  'pm-domain/weather': 'bg-sky-500/20 text-sky-400 border-sky-500/30',
  'pm-domain/geopolitics': 'bg-red-500/20 text-red-400 border-red-500/30',
}

const STRENGTH_STYLES: Record<string, string> = {
  strong: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  moderate: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  weak: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30',
}

export default function SignalPage(): React.ReactElement {
  const [question, setQuestion] = useState('')
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<SignalData | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleAnalyze(): Promise<void> {
    if (!question.trim()) return

    setLoading(true)
    setError(null)
    setData(null)

    try {
      const res = await fetch(`/api/signal?question=${encodeURIComponent(question)}`)
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setError(body.error ?? `API error: ${res.status}`)
        return
      }
      const result = (await res.json()) as SignalData
      setData(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  const signalPct = data ? Math.round(data.aggregatedSignal * 100) : 0

  return (
    <main className="min-h-screen px-4 py-12 max-w-2xl mx-auto">
      {/* Nav */}
      <div className="mb-8">
        <Link href="/" className="text-zinc-500 hover:text-zinc-300 text-sm">
          &larr; Back to search
        </Link>
      </div>

      {/* Header */}
      <div className="mb-10">
        <h1 className="text-3xl font-bold text-white">Market Signal</h1>
        <p className="mt-2 text-zinc-400">
          Find who knows this market
        </p>
      </div>

      {/* Input */}
      <div className="flex gap-3 mb-10">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleAnalyze() }}
          placeholder="Enter a market question..."
          className="flex-1 px-4 py-3 bg-zinc-900 border border-zinc-700 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
        />
        <button
          onClick={() => void handleAnalyze()}
          disabled={loading || !question.trim()}
          className="px-6 py-3 bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white font-medium rounded-lg transition-colors"
        >
          {loading ? 'Analyzing...' : 'Analyze'}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="text-red-400 text-center py-8">{error}</div>
      )}

      {/* Results */}
      {data && (
        <div className="space-y-8">
          {/* Domain detected */}
          <div>
            <div className="text-xs uppercase tracking-wider text-zinc-500 mb-2">
              Domain Detected
            </div>
            {data.domain ? (
              <span className={`inline-block px-3 py-1 rounded-full text-sm font-medium border ${DOMAIN_COLORS[data.domain] ?? 'bg-zinc-700 text-zinc-300'}`}>
                {DOMAIN_LABELS[data.domain] ?? data.domain}
              </span>
            ) : (
              <span className="text-zinc-500">No domain detected</span>
            )}
          </div>

          {/* Expert consensus */}
          {data.expertsFound > 0 ? (
            <>
              <div>
                <div className="text-xs uppercase tracking-wider text-zinc-500 mb-3">
                  Expert Consensus
                </div>
                <div className="relative h-3 bg-zinc-800 rounded-full overflow-visible">
                  <div
                    className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-indigo-500 rounded-full border-2 border-white shadow-lg transition-all"
                    style={{ left: `calc(${signalPct}% - 8px)` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-zinc-500 mt-2">
                  <span>Bearish 0%</span>
                  <span>{signalPct}%</span>
                  <span>100% Bullish</span>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <span className={`px-3 py-1 rounded-full text-xs font-medium border ${STRENGTH_STYLES[data.signalStrength]}`}>
                  {data.signalStrength}
                </span>
                <span className="text-zinc-500 text-sm">
                  Based on {data.expertsFound} calibrated expert{data.expertsFound !== 1 ? 's' : ''}
                </span>
              </div>

              {/* Expert list */}
              <div>
                <div className="text-xs uppercase tracking-wider text-zinc-500 mb-3">
                  Top Experts in This Domain
                </div>
                <div className="space-y-2">
                  {data.experts.map((expert) => (
                    <div
                      key={expert.address}
                      className="flex items-center justify-between px-4 py-3 bg-zinc-900 border border-zinc-800 rounded-lg"
                    >
                      <span className="font-mono text-sm text-white">{expert.address}</span>
                      <div className="flex gap-4 text-xs text-zinc-400">
                        <span>Cal: {Math.round(expert.calibration * 100)}%</span>
                        <span>Conv: {Math.round(expert.convictionScore * 100)}%</span>
                        <span>{expert.trades} trades</span>
                        <span>Avg: {Math.round(expert.avgPosition * 100)}%</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="text-center py-12 border border-zinc-800 rounded-xl">
              <p className="text-zinc-400 text-lg">No calibrated experts found for this domain yet.</p>
              <p className="text-zinc-600 mt-2">Try indexing more wallets.</p>
            </div>
          )}
        </div>
      )}
    </main>
  )
}
