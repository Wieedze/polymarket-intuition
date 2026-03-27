import type { Metadata } from 'next'
import './globals.css'
import { RefreshProvider } from './providers'

export const metadata: Metadata = {
  title: 'Proof of Prediction',
  description:
    'Verifiable on-chain reputation for prediction market traders. Powered by Polymarket & Intuition.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}): React.ReactElement {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <RefreshProvider>{children}</RefreshProvider>
      </body>
    </html>
  )
}
