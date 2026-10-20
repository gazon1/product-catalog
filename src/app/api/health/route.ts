import { NextResponse } from 'next/server';
import { ping } from '@/lib/queries';

export const dynamic = 'force-dynamic';

/**
 * How long one readiness answer is reused.
 *
 * The probe is called by the deploy workflow, by the container's health check
 * and by anything that watches the endpoint — and a page render does not need
 * the answer to be fresh to the millisecond. Five seconds is short enough that
 * a crawler that comes back is noticed almost immediately, and long enough
 * that a burst of requests does not turn into a burst of probes against the
 * crawler.
 *
 * A negative answer is cached too, and for the same reason: an API that is
 * down is exactly the case where the hammering would be worst.
 */
const READINESS_TTL_MS = 5_000;

let cached: { ok: boolean; at: number } | null = null;

/**
 * Deployment health probe.
 *
 * Returns 200 with `{"ok":true}` when the crawler can serve the catalog, and
 * 503 when it cannot. The distinction is the whole point: a server that
 * starts fine without a reachable catalog is *running* but not *serving*, and
 * the deploy workflow's smoke test (`curl … | grep '"ok"'`) needs exactly that
 * to fail loudly rather than report a successful rollout of a site that shows
 * an error page.
 *
 * The cache lives in the module, so it is per process: a serverless runtime
 * that keeps no module between requests simply probes every time, which is
 * slower but never wrong.
 */
export async function GET() {
  const now = Date.now();
  let ok: boolean;

  if (cached !== null && now - cached.at < READINESS_TTL_MS) {
    ok = cached.ok;
  } else {
    ok = await ping();
    cached = { ok, at: Date.now() };
  }

  return NextResponse.json(
    { ok, timestamp: new Date().toISOString() },
    {
      status: ok ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    }
  );
}
