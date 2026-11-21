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
 * The probe already in flight, if any.
 *
 * Without it, every request that arrives after the cache expires starts a probe
 * of its own — and the moment the entry expires is exactly the moment a burst
 * arrives together. The cache promises that a burst is one probe; this is what
 * makes that promise true, and a parser outage is when it matters most.
 */
let inFlight: Promise<{ ok: boolean; detail: string | null }> | null = null;

/**
 * Readiness: can the catalog be served?
 *
 * Returns 200 when the crawler's own readiness probe answers, and 503 when it
 * does not — with the reason class in `detail` (`unreachable`, `timeout`,
 * `unauthorized`, `not-ready`, `error`), because "the catalog is down" is not an
 * answer an operator can act on. The class, not the error text: this endpoint is
 * publicly reachable, and the client's message names the crawler's address, the
 * path and the request id. The full message stays in the container log.
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
    if (inFlight === null) {
      inFlight = ping().finally(() => {
        inFlight = null;
      });
    }
    const answer = await inFlight;
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
