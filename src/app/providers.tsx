'use client'

import { createContext, useContext, useState, useEffect, useCallback } from 'react'

type RefreshContextType = {
  tick: number          // increments every 30s or on manual refresh
  refresh: () => void   // call from any page to refresh all pages
}

const RefreshContext = createContext<RefreshContextType>({ tick: 0, refresh: () => {} })

export function RefreshProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [tick, setTick] = useState(0)

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    const interval = setInterval(refresh, 30_000)
    return () => clearInterval(interval)
  }, [refresh])

  return (
    <RefreshContext.Provider value={{ tick, refresh }}>
      {children}
    </RefreshContext.Provider>
  )
}

export function useRefresh(): RefreshContextType {
  return useContext(RefreshContext)
}
