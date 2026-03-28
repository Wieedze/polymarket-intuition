'use client'

import Link from 'next/link'

const COLORS = {
  bg: '#171821', card: '#21222D', surface: '#2B2B36',
  teal: '#A9DFD8', amber: '#FCB859', pink: '#F2C8ED',
  red: '#EA1701', green: '#029F04', blue: '#28AEF3',
  textMuted: '#87888C', textLight: '#D2D2D2',
}

function SideLink({ href, children, active }: { href: string; children: React.ReactNode; active?: boolean }): React.ReactElement {
  return (
    <Link href={href} className="px-3 py-2 rounded-lg text-sm transition-colors"
      style={{ background: active ? COLORS.surface : 'transparent', color: active ? 'white' : COLORS.textMuted }}>
      {children}
    </Link>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="rounded-xl p-5 mb-5" style={{ background: COLORS.card }}>
      <h2 className="text-sm font-semibold uppercase tracking-wider mb-4" style={{ color: COLORS.teal }}>{title}</h2>
      {children}
    </div>
  )
}

function RuleRow({ label, value, detail, color }: { label: string; value: string; detail?: string; color?: string }): React.ReactElement {
  return (
    <div className="flex items-center justify-between py-2 border-b" style={{ borderColor: COLORS.surface }}>
      <div>
        <span className="text-sm" style={{ color: COLORS.textLight }}>{label}</span>
        {detail && <span className="text-xs ml-2" style={{ color: COLORS.textMuted }}>{detail}</span>}
      </div>
      <span className="text-sm font-mono font-semibold" style={{ color: color ?? COLORS.amber }}>{value}</span>
    </div>
  )
}

function Badge({ children, color }: { children: React.ReactNode; color: string }): React.ReactElement {
  return (
    <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: color + '22', color }}>{children}</span>
  )
}

export default function RulesPage(): React.ReactElement {
  return (
    <div className="min-h-screen" style={{ background: COLORS.bg, color: COLORS.textLight }}>
      <div className="flex">
        <aside className="hidden lg:flex flex-col w-56 min-h-screen p-5 border-r" style={{ background: COLORS.card, borderColor: COLORS.surface }}>
          <div className="mb-10">
            <h1 className="text-lg font-bold text-white">Copy Trader</h1>
            <p className="text-xs mt-1" style={{ color: COLORS.textMuted }}>Paper simulation</p>
          </div>
          <nav className="flex flex-col gap-1">
            <SideLink href="/">Dashboard</SideLink>
            <SideLink href="/analytics">Analytics</SideLink>
            <SideLink href="/paper-trading">Trades</SideLink>
            <SideLink href="/activity">Activity</SideLink>
            <SideLink href="/leaderboard">Leaderboard</SideLink>
            <SideLink href="/rules" active>Rules</SideLink>
            <SideLink href="/settings">Settings</SideLink>
          </nav>
        </aside>

        <main className="flex-1 p-6 lg:p-8 max-w-5xl">
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-white">Trading Rules</h1>
            <p className="text-sm mt-1" style={{ color: COLORS.textMuted }}>All safety parameters, thresholds, and investment rules in one place</p>
          </div>

          {/* ── 1. SIGNAL GATE ─────────────────────────────── */}
          <Section title="1. Signal Quality Gate">
            <p className="text-xs mb-3" style={{ color: COLORS.textMuted }}>Every signal is scored 0-100 before copying. Score must pass minimum threshold.</p>
            <RuleRow label="Minimum score to copy" value="40 / 100" />
            <RuleRow label="Score 40-59 bet multiplier" value="0.5x" detail="cautious" />
            <RuleRow label="Score 60-79 bet multiplier" value="1.0x" detail="standard" />
            <RuleRow label="Score 80+ bet multiplier" value="1.5x" detail="high conviction" />

            <h3 className="text-xs font-semibold uppercase tracking-wider mt-5 mb-3" style={{ color: COLORS.textMuted }}>Score Components (100 pts max)</h3>
            <RuleRow label="Domain match" value="30 pts" detail="expert's #1 domain = 30, 10+ trades = 20, 5+ = 10" color={COLORS.teal} />
            <RuleRow label="Calibration" value="20 pts" detail="expert calibration in this domain" color={COLORS.teal} />
            <RuleRow label="Implicit edge" value="15 pts" detail="beats market implied probability" color={COLORS.teal} />
            <RuleRow label="Entry price" value="15 pts" detail="15-30c = 15, 30-55c = 12, 55-65c = 3" color={COLORS.teal} />
            <RuleRow label="Win rate" value="10 pts" detail="WR >= 60% = 10, >= 50% = 7, >= 40% = 4" color={COLORS.teal} />
            <RuleRow label="Bet size signal" value="10 pts" detail=">50K shares = 10, >10K = 7, >1K = 4" color={COLORS.teal} />
          </Section>

          {/* ── 2. ENTRY FILTERS ────────────────────────────── */}
          <Section title="2. Entry Filters">
            <p className="text-xs mb-3" style={{ color: COLORS.textMuted }}>Hard blocks and filters applied before scoring.</p>
            <RuleRow label="Min entry price" value="15c" detail="skip extreme longshots" />
            <RuleRow label="Max entry price" value="60c" detail="data shows 70-90c loses $3,752" />
            <RuleRow label="Hard block above" value="65c" detail="signal score = 0, no exceptions" color={COLORS.red} />
            <RuleRow label="Max open positions" value="50" />
            <RuleRow label="Max capital deployed" value="60%" detail="of current balance" />

            <h3 className="text-xs font-semibold uppercase tracking-wider mt-5 mb-3" style={{ color: COLORS.textMuted }}>Blocked</h3>
            <div className="flex gap-2 mb-2">
              <Badge color={COLORS.red}>pm-domain/crypto</Badge>
              <Badge color={COLORS.red}>5-min up/down markets</Badge>
              <Badge color={COLORS.red}>Narrow price range bets</Badge>
            </div>
          </Section>

          {/* ── 3. BET SIZING ──────────────────────────────── */}
          <Section title="3. Bet Sizing">
            <p className="text-xs mb-3" style={{ color: COLORS.textMuted }}>Kelly criterion + signal quality + consensus + trust level.</p>
            <RuleRow label="Base bet" value="2% of cash" detail="BET_PCT = 0.02" />
            <RuleRow label="Minimum bet" value="$20" />
            <RuleRow label="Maximum bet" value="$500" />
            <RuleRow label="Kelly fraction cap" value="25%" detail="quarter-Kelly for safety" />

            <h3 className="text-xs font-semibold uppercase tracking-wider mt-5 mb-3" style={{ color: COLORS.textMuted }}>Consensus Multiplier (inverted)</h3>
            <RuleRow label="1 expert" value="1.0x" detail="fresh signal, full size" color={COLORS.green} />
            <RuleRow label="2 experts" value="0.7x" detail="crowded, reduce" color={COLORS.amber} />
            <RuleRow label="3+ experts" value="0.5x" detail="likely late entry" color={COLORS.amber} />
            <RuleRow label="5+ experts" value="0.3x" detail="edge gone" color={COLORS.red} />
          </Section>

          {/* ── 4. SLIPPAGE & FEES ─────────────────────────── */}
          <Section title="4. Slippage & Fees">
            <RuleRow label="Taker fee" value="2%" detail="entry + early exit (not at resolution)" />

            <h3 className="text-xs font-semibold uppercase tracking-wider mt-5 mb-3" style={{ color: COLORS.textMuted }}>Slippage by Entry Price</h3>
            <RuleRow label="< 20c (extreme longshot)" value="6%" color={COLORS.red} />
            <RuleRow label="20-30c (longshot)" value="5%" color={COLORS.amber} />
            <RuleRow label="30-50c (value)" value="3%" color={COLORS.amber} />
            <RuleRow label="> 50c" value="2%" color={COLORS.green} />
            <RuleRow label="Size impact" value="+0.5% / $100" detail="each $100 bet adds 0.5% slippage" />
          </Section>

          {/* ── 5. EXIT STRATEGY ────────────────────────────── */}
          <Section title="5. Exit Strategy">
            <p className="text-xs mb-3" style={{ color: COLORS.textMuted }}>10 different exit triggers evaluated every poll cycle.</p>
            <RuleRow label="Stop-loss" value="-25%" detail="cut losses, -20% for longshots < 30c" color={COLORS.red} />
            <RuleRow label="Near-resolution (win)" value="85c+" detail="sell token when near certain win" color={COLORS.green} />
            <RuleRow label="Near-resolution (loss)" value="15c-" detail="cut losses before full resolution" color={COLORS.red} />
            <RuleRow label="Stale position" value="7 days" detail="exit if price moved < 3c in 7 days" />
            <RuleRow label="Follow expert exit" value="ON" detail="close when expert closes" color={COLORS.teal} />

            <h3 className="text-xs font-semibold uppercase tracking-wider mt-5 mb-3" style={{ color: COLORS.textMuted }}>Partial Exits (Free Capital)</h3>
            <RuleRow label="At +100% profit" value="sell 50%" detail="lock gains, keep upside" color={COLORS.green} />
            <RuleRow label="At +150% profit" value="sell 30% more" detail="20% rides free to resolution" color={COLORS.green} />

            <h3 className="text-xs font-semibold uppercase tracking-wider mt-5 mb-3" style={{ color: COLORS.textMuted }}>Disabled</h3>
            <RuleRow label="Take profit (fixed %)" value="OFF" detail="near-resolution used instead" color={COLORS.textMuted} />
            <RuleRow label="Trailing stop" value="OFF" detail="bad for binary markets" color={COLORS.textMuted} />
          </Section>

          {/* ── 6. EXPERT TRUST ─────────────────────────────── */}
          <Section title="6. Expert Trust System">
            <p className="text-xs mb-3" style={{ color: COLORS.textMuted }}>Dynamic trust level (0-1.5x) applied to bet size. P&L is king: profitable wallets are never reduced for low WR alone.</p>

            <h3 className="text-xs font-semibold uppercase tracking-wider mt-4 mb-3" style={{ color: COLORS.textMuted }}>Phases</h3>
            <RuleRow label="Observation" value="< 20 trades" detail="default trust 70%" color={COLORS.amber} />
            <RuleRow label="Evaluation" value="20-60 trades" detail="trust 30-120% (rolling 15 trades)" color={COLORS.blue} />
            <RuleRow label="Proven" value="60+ trades" detail="trust 40-150% (full history + last 20)" color={COLORS.green} />

            <h3 className="text-xs font-semibold uppercase tracking-wider mt-5 mb-3" style={{ color: COLORS.textMuted }}>Pause (trust = 0, stop copying)</h3>
            <RuleRow label="Observation" value="5+ trades, PnL < -$300" color={COLORS.red} />
            <RuleRow label="Evaluation" value="30+ trades, WR < 30% AND PnL < -$200" color={COLORS.red} />
            <RuleRow label="Proven" value="last 20: WR < 25% AND PnL < -$300" color={COLORS.red} />

            <h3 className="text-xs font-semibold uppercase tracking-wider mt-5 mb-3" style={{ color: COLORS.textMuted }}>Reduce (trust = 30-40%)</h3>
            <RuleRow label="Observation" value="3+ trades, PnL < -$100" color={COLORS.amber} />
            <RuleRow label="Evaluation" value="recent PnL < -$100 OR (WR < 35% AND total PnL < 0)" color={COLORS.amber} />
            <RuleRow label="Proven" value="recent PnL < -$100 OR (WR < 35% AND total PnL < 0)" color={COLORS.amber} />
            <div className="mt-3 p-3 rounded-lg" style={{ background: COLORS.surface }}>
              <p className="text-xs" style={{ color: COLORS.teal }}>Longshot rule: a wallet with WR 35% but positive PnL stays active. The system never punishes profitable traders for low win rate.</p>
            </div>
          </Section>

          {/* ── 7. DOMAIN MULTIPLIERS ──────────────────────── */}
          <Section title="7. Domain Performance Multiplier">
            <p className="text-xs mb-3" style={{ color: COLORS.textMuted }}>Expert's track record in this specific domain boosts or penalizes the signal score.</p>
            <RuleRow label="Excellent (cal >= 75%, WR >= 55%)" value="1.5x" color={COLORS.green} />
            <RuleRow label="Good (cal >= 65%, WR >= 50%)" value="1.2x" color={COLORS.teal} />
            <RuleRow label="Neutral" value="1.0x" />
            <RuleRow label="No history in domain" value="0.7x" detail="cautious" color={COLORS.amber} />
            <RuleRow label="Poor (cal < 55% OR WR < 35%)" value="0.5x" color={COLORS.red} />
            <RuleRow label="Unknown domain (unclassified)" value="0x" detail="skipped entirely" color={COLORS.red} />
          </Section>

          {/* ── 8. VALIDATION GATES ────────────────────────── */}
          <Section title="8. Live Trading Gates">
            <p className="text-xs mb-3" style={{ color: COLORS.textMuted }}>All gates must pass before transitioning from paper to real trading.</p>
            <RuleRow label="Profit Factor" value=">= 1.30" detail="gross wins / gross losses" />
            <RuleRow label="Max consecutive losses" value="<= 15" detail="worst losing streak" />
            <RuleRow label="Avg PnL per trade" value="> $5" detail="minimum per-trade profitability" />
            <RuleRow label="Resolved trades" value=">= 4,000" detail="~10 days at 400/day" />

            <h3 className="text-xs font-semibold uppercase tracking-wider mt-5 mb-3" style={{ color: COLORS.textMuted }}>Statistical Significance</h3>
            <RuleRow label="< 100 trades" value="not significant" color={COLORS.red} />
            <RuleRow label="100-999 trades" value="low" color={COLORS.amber} />
            <RuleRow label="1,000-3,999 trades" value="medium" color={COLORS.amber} />
            <RuleRow label="4,000+ trades" value="high" color={COLORS.green} />
          </Section>

          {/* ── 9. POLL & TIMING ───────────────────────────── */}
          <Section title="9. Bot Timing">
            <RuleRow label="Poll interval" value="30s" detail="fetch expert positions every 30s" />
            <RuleRow label="Dashboard refresh" value="30s" detail="shared React Context timer" />
            <RuleRow label="Leaderboard cache TTL" value="30 min" />
          </Section>

        </main>
      </div>
    </div>
  )
}
