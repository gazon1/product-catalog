import { NextResponse } from 'next/server';
import { ping } from '@/lib/queries';

export const dynamic = 'force-dynamic';

/**
 * How long one readiness answer is reused.
 *
 * Readiness is asked by the deploy workflow and by anything that watches the
 * endpoint — and a page render does not need the answer to be fresh to the
 * millisecond. Five seconds is short enough that a crawler that comes back is
 * noticed almost immediately, and long enough that a burst of requests does not
 * turn into a burst of probes against the crawler.
 *
 * A negative answer is cached too, and for the same reason: an API that is
 * down is exactly the case where the hammering would be worst.
 */
const READINESS_TTL_MS = 5_000;

let cached: { ok: boolean; detail: string | null; at: number } | null = null;

/**
 * Readiness: can the catalog be served?
 *
 * Returns 200 when the crawler's own readiness probe answers, and 503 when it
 * does not — with the reason in `detail`, because "the catalog is down" is not
 * an answer an operator can act on.
 *
 * This is a dependency check, not liveness: a process that serves this 503 is
 * still running, and `/api/health` says so. Keeping the two apart is what stops
 * a parser outage from looking like a dead storefront.
 *
 * The cache lives in the module, so it is per process: a serverless runtime
 * that keeps no module between requests simply probes every time, which is
 * slower but never wrong.
 */
export async function GET() {
  const now = Date.now();

  if (cached === null || now - cached.at >= READINESS_TTL_MS) {
    const answer = await ping();
    cached = { ...answer, at: Date.now() };
  }

  return NextResponse.json(
    {
      ok: cached.ok,
      parser: cached.ok ? 'ready' : 'not-ready',
      detail: cached.detail,
      timestamp: new Date().toISOString(),
    },
    {
      status: cached.ok ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    }
  );
}
