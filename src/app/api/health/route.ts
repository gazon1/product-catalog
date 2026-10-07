import { NextResponse } from 'next/server';
import { ping } from '@/lib/queries';

export const dynamic = 'force-dynamic';

/**
 * Deployment health probe.
 *
 * Returns 200 with `{"ok":true}` when the database answers, and 503 when it does
 * not. The distinction is the whole point: a server that starts fine without a
 * reachable database is *running* but not *serving*, and the deploy workflow's
 * smoke test (`curl … | grep '"ok"'`) needs exactly that to fail loudly rather
 * than report a successful rollout of a site that shows an error page.
 */
export async function GET() {
  const ok = await ping();
  return NextResponse.json(
    { ok, timestamp: new Date().toISOString() },
    {
      status: ok ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    }
  );
}