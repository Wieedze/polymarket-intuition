'use client'

import { useParams, useRouter } from 'next/navigation'
import { useState } from 'react'
import ReputationProfile from '../../../components/ReputationProfile'

export default function ProfilePage(): React.ReactElement {
  const params = useParams<{ address: string }>()
  const router = useRouter()
  const [copied, setCopied] = useState(false)

  const address = params.address

  function handleShare(): void {
    navigator.clipboard.writeText(window.location.href).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {
      // Fallback: do nothing
    })
  }

  return (
    <main className="min-h-screen px-4 py-8 max-w-5xl mx-auto">
      {/* Navigation */}
      <div className="flex items-center justify-between mb-8">
        <button
          onClick={() => router.push('/')}
          className="text-zinc-400 hover:text-white transition-colors text-sm"
        >
          &larr; Back to search
        </button>
        <button
          onClick={handleShare}
          className="px-4 py-2 rounded-lg border border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:text-white transition-colors text-sm"
        >
          {copied ? 'Copied!' : 'Share'}
        </button>
      </div>

      <ReputationProfile address={address} />
    </main>
  )
}
