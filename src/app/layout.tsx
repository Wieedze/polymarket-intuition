import type { Metadata } from 'next'
import './globals.css'
import { RefreshProvider } from './providers'
import Sidebar from '../components/Sidebar'

export const metadata: Metadata = {
  title: 'Copy Trader — Live Dashboard',
  description: 'Live trading dashboard for Polymarket copy-trading bot.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}): React.ReactElement {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased" style={{ background: '#0F1117' }}>
        <RefreshProvider>
          <div className="flex min-h-screen">
            <Sidebar />
            <main className="flex-1 overflow-auto">
              {children}
            </main>
          </div>
        </RefreshProvider>
      </body>
    </html>
  )
}
