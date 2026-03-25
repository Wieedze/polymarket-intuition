import TrustBadge from './TrustBadge'
import type { TradingStyle } from '../lib/scorer'

type DomainCardProps = {
  domain: string
  winRate: number
  trades: number
  calibration: number
  convictionScore: number
  tradingStyle: TradingStyle
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

export default function DomainCard({
  domain,
  winRate,
  trades,
  calibration,
  convictionScore,
  tradingStyle,
  compositeScore,
  agentRank,
}: DomainCardProps): React.ReactElement {
  const meta = DOMAIN_LABELS[domain] ?? { label: domain, color: 'bg-zinc-500' }
  const winPct = Math.round(winRate * 100)
  const calPct = Math.round(calibration * 100)
  const convPct = Math.round(convictionScore * 100)
  const style = STYLE_LABELS[tradingStyle]

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 hover:border-zinc-700 transition-colors">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${meta.color}`} />
          <span className="font-semibold text-white">{meta.label}</span>
        </div>
        {compositeScore !== undefined && (
          <TrustBadge score={compositeScore} rank={agentRank} />
        )}
      </div>

      {/* Win rate bar */}
      <div className="mb-3">
        <div className="flex justify-between text-xs text-zinc-400 mb-1">
          <span>Win Rate</span>
          <span>{winPct}%</span>
        </div>
        <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-indigo-500 rounded-full transition-all"
            style={{ width: `${winPct}%` }}
          />
        </div>
      </div>

      {/* Calibration bar */}
      <div className="mb-3">
        <div className="flex justify-between text-xs text-zinc-400 mb-1">
          <span>Calibration</span>
          <span>{calPct}%</span>
        </div>
        <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-emerald-500 rounded-full transition-all"
            style={{ width: `${calPct}%` }}
          />
        </div>
      </div>

      {/* Conviction score bar */}
      <div className="mb-4">
        <div className="flex justify-between text-xs text-zinc-400 mb-1">
          <span>Conviction</span>
          <span>{convPct}%</span>
        </div>
        <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-amber-500 rounded-full transition-all"
            style={{ width: `${convPct}%` }}
          />
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-zinc-500">
          {trades} trade{trades !== 1 ? 's' : ''}
        </span>
        <span className={`text-[10px] px-2 py-0.5 rounded-full border ${style.color}`}>
          {style.label}
        </span>
      </div>
    </div>
  )
}
