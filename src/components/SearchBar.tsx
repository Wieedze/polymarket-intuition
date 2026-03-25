'use client'

import { useState, type FormEvent } from 'react'

type SearchBarProps = {
  onSearch: (address: string) => void
}

export default function SearchBar({ onSearch }: SearchBarProps): React.ReactElement {
  const [address, setAddress] = useState('')
  const [error, setError] = useState('')

  function handleSubmit(e: FormEvent): void {
    e.preventDefault()
    const trimmed = address.trim()

    if (!trimmed.startsWith('0x') || trimmed.length < 10) {
      setError('Enter a valid wallet address starting with 0x')
      return
    }

    setError('')
    onSearch(trimmed)
  }

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-xl mx-auto">
      <div className="flex gap-3">
        <input
          type="text"
          value={address}
          onChange={(e) => {
            setAddress(e.target.value)
            setError('')
          }}
          placeholder="Enter wallet address 0x..."
          className="flex-1 px-4 py-3 rounded-lg bg-zinc-900 border border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 font-mono text-sm"
        />
        <button
          type="submit"
          className="px-6 py-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-colors whitespace-nowrap"
        >
          View Reputation
        </button>
      </div>
      {error && (
        <p className="mt-2 text-sm text-red-400">{error}</p>
      )}
    </form>
  )
}
