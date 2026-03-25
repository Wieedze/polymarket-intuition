export const DOMAIN_ATOMS = {
  AI_TECH: 'pm-domain/ai-tech',
  POLITICS: 'pm-domain/politics',
  CRYPTO: 'pm-domain/crypto',
  SPORTS: 'pm-domain/sports',
  ECONOMICS: 'pm-domain/economics',
  SCIENCE: 'pm-domain/science',
  CULTURE: 'pm-domain/culture',
  WEATHER: 'pm-domain/weather',
  GEOPOLITICS: 'pm-domain/geopolitics',
} as const

export const PREDICATE_ATOMS = {
  PREDICTED_CORRECTLY: 'predicted-correctly-in',
  PREDICTED_INCORRECTLY: 'predicted-incorrectly-in',
  HAS_REPUTATION: 'has-prediction-reputation-in',
} as const

export type DomainAtomKey = keyof typeof DOMAIN_ATOMS
export type DomainAtomValue = (typeof DOMAIN_ATOMS)[DomainAtomKey]

// Will be populated by /init-atoms with on-chain term IDs (bytes32)
export const ATOM_IDS: Partial<Record<DomainAtomValue | string, string>> = {}
