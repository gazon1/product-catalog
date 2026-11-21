import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Liveness: is this application process able to answer HTTP?
 *
 * The answer is `200` whenever the process is running — it asks the crawler
 * nothing. A parser outage is a dependency problem, and `/api/ready` reports it
 * separately: a container that is restarted because somebody else's service is
 * down only adds noise while the catalog is already unhealthy.
 *
 * The container healthcheck and the deploy smoke test ask this endpoint and
 * only this one.
 */
export function GET() {
  return NextResponse.json(
    { ok: true, timestamp: new Date().toISOString() },
    {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    }
  );
}
