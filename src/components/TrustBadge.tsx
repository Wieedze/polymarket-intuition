type TrustBadgeProps = {
  score: number
  rank?: number
}

function getScoreColor(score: number): string {
  if (score >= 0.7) return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
  if (score >= 0.5) return 'bg-amber-500/20 text-amber-400 border-amber-500/30'
  return 'bg-red-500/20 text-red-400 border-red-500/30'
}

export default function TrustBadge({ score, rank }: TrustBadgeProps): React.ReactElement {
  return (
    <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-sm font-medium ${getScoreColor(score)}`}>
      <span>{(score * 100).toFixed(0)}%</span>
      {rank !== undefined && (
        <span className="text-zinc-400 text-xs">#{rank}</span>
      )}
    </div>
  )
}
