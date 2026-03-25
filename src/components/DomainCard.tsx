import TrustBadge from './TrustBadge'
import type { TradingStyle } from '../lib/scorer'

type DomainCardProps = {
  domain: string
  winRate: number
  trades: number
  calibration: number
  convictionScore: number
  tradingStyle: TradingStyle
  profitFactor: number
  avgPnlPerTrade: number
  maxConsecutiveLosses: number
  copyabilityScore: number
  compositeScore?: number
  agentRank?: number
}

const DOMAIN_LABELS: Record<string, { label: string; color: string }> = {
  'pm-domain/ai-tech':     { label: 'AI & Tech',    color: 'bg-violet-500' },
  'pm-domain/politics':    { label: 'Politics',     color: 'bg-blue-500' },
  'pm-domain/crypto':      { label: 'Crypto',       color: 'bg-orange-500' },
  'pm-domain/sports':      { label: 'Sports',       color: 'bg-green-500' },
  'pm-domain/economics':   { label: 'Economics',    color: 'bg-yellow-500' },
  'pm-domain/science':     { label: 'Science',      color: 'bg-cyan-500' },
  'pm-domain/culture':     { label: 'Culture',      color: 'bg-pink-500' },
  'pm-domain/weather':     { label: 'Weather',      color: 'bg-sky-500' },
  'pm-domain/geopolitics': { label: 'Geopolitics',  color: 'bg-red-500' },
}

const STYLE_LABELS: Record<TradingStyle, { label: string; color: string }> = {
  'longshot-hunter': { label: 'Longshot Hunter', color: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  'value-trader':    { label: 'Value Trader',    color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  'directional':     { label: 'Directional',     color: 'text-indigo-400 bg-indigo-500/10 border-indigo-500/20' },
  'mixed':           { label: 'Mixed',           color: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/20' },
}

function copyabilityColor(score: number): string {
  if (score >= 0.6) return 'text-emerald-400'
  if (score >= 0.4) return 'text-yellow-400'
  return 'text-red-400'
}

function profitFactorLabel(pf: number): string {
  if (pf == null || !isFinite(pf)) return '∞'
  if (pf >= 100) return pf.toFixed(0)
  return pf.toFixed(2)
}

export default function DomainCard({
  domain,
  winRate,
  trades,
  calibration,
  convictionScore,
  tradingStyle,
  profitFactor,
  avgPnlPerTrade,
  maxConsecutiveLosses,
  copyabilityScore,
  compositeScore,
  agentRank,
}: DomainCardProps): React.ReactElement {
  const meta = DOMAIN_LABELS[domain] ?? { label: domain, color: 'bg-zinc-500' }
  const winPct = Math.round(winRate * 100)
  const calPct = Math.round(calibration * 100)
  const copyPct = Math.round(copyabilityScore * 100)
  const style = STYLE_LABELS[tradingStyle]

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 hover:border-zinc-700 transition-colors">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${meta.color}`} />
          <span className="font-semibold text-white">{meta.label}</span>
        </div>
        {compositeScore !== undefined ? (
          <TrustBadge score={compositeScore} rank={agentRank} />
        ) : (
          <span className={`text-[10px] px-2 py-0.5 rounded-full border ${style.color}`}>
            {style.label}
          </span>
        )}
      </div>

      {/* Copyability Score — the hero metric */}
      <div className="mb-4 p-3 rounded-lg bg-zinc-800/50">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium text-zinc-300">Copyability</span>
          <span className={`text-lg font-bold ${copyabilityColor(copyabilityScore)}`}>
            {copyPct}%
          </span>
        </div>
        <div className="h-2 bg-zinc-700 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              copyabilityScore >= 0.6 ? 'bg-emerald-500' :
              copyabilityScore >= 0.4 ? 'bg-yellow-500' : 'bg-red-500'
            }`}
            style={{ width: `${copyPct}%` }}
          />
        </div>
      </div>

      {/* Stat grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 mb-4">
        <div className="flex justify-between text-xs">
          <span className="text-zinc-500">Win Rate</span>
          <span className="text-zinc-300">{winPct}%</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-zinc-500">Calibration</span>
          <span className="text-zinc-300">{calPct}%</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-zinc-500">Profit Factor</span>
          <span className={`${profitFactor >= 1.5 ? 'text-emerald-400' : profitFactor >= 1 ? 'text-zinc-300' : 'text-red-400'}`}>
            {profitFactorLabel(profitFactor)}x
          </span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-zinc-500">Avg PnL/Trade</span>
          <span className={`${avgPnlPerTrade >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {avgPnlPerTrade >= 0 ? '+' : ''}{avgPnlPerTrade.toFixed(1)}
          </span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-zinc-500">Conviction</span>
          <span className="text-zinc-300">{Math.round(convictionScore * 100)}%</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-zinc-500">Max Streak Loss</span>
          <span className={`${maxConsecutiveLosses <= 5 ? 'text-zinc-300' : 'text-red-400'}`}>
            {maxConsecutiveLosses}
          </span>
        </div>
      </div>

      {/* Footer */}
      <div className="text-xs text-zinc-500">
        {trades} trade{trades !== 1 ? 's' : ''}
      </div>
    </div>
  )
}
