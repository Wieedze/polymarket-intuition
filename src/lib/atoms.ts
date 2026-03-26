export const DOMAIN_ATOMS = {
  AI_TECH:     'pm-domain/ai-tech',
  POLITICS:    'pm-domain/politics',
  CRYPTO:      'pm-domain/crypto',
  SPORTS:      'pm-domain/sports',
  ECONOMICS:   'pm-domain/economics',
  SCIENCE:     'pm-domain/science',
  CULTURE:     'pm-domain/culture',
  WEATHER:     'pm-domain/weather',
  GEOPOLITICS: 'pm-domain/geopolitics',
} as const

export type DomainAtomKey   = keyof typeof DOMAIN_ATOMS
export type DomainAtomValue = (typeof DOMAIN_ATOMS)[DomainAtomKey]
