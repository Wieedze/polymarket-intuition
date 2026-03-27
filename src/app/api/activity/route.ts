import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

export type BotEvent = {
  id: number
  type: string
  message: string
  detail: string | null
  createdAt: string
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const url = new URL(request.url)
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '200'), 500)
    const type = url.searchParams.get('type') ?? null
    const search = url.searchParams.get('search') ?? null

    const db = getDb()

    let query = 'SELECT id, type, message, detail, created_at FROM bot_events'
    const params: (string | number)[] = []
    const conditions: string[] = []

    if (type) {
      conditions.push('type = ?')
      params.push(type)
    }
    if (search) {
      conditions.push('(message LIKE ? OR detail LIKE ?)')
      params.push(`%${search}%`, `%${search}%`)
    }
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ')
    }
    query += ' ORDER BY id DESC LIMIT ?'
    params.push(limit)

    const rows = (db.prepare(query).all(...params) as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as number,
      type: r.type as string,
      message: r.message as string,
      detail: r.detail as string | null,
      createdAt: r.created_at as string,
    }))

    // Count by type for filter badges
    const typeCounts = (db.prepare(
      'SELECT type, COUNT(*) as count FROM bot_events GROUP BY type ORDER BY count DESC'
    ).all() as Array<{ type: string; count: number }>)

    return NextResponse.json({ events: rows, typeCounts, total: rows.length })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
