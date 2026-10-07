/**
 * Same-origin product image proxy.
 *
 * ## The allowlist is the security boundary, not an optimisation
 *
 * `?url=` is attacker-controllable: anyone can request
 * `/product-image?url=http://169.254.169.254/latest/meta-data/`. Without a
 * host check that is a working SSRF from inside the network the container sits
 * in — reachable on cloud metadata services, the Postgres host, and anything
 * else only routable locally.
 *
 * So: HTTPS only, and the host must be in the allowlist. `ALLOWED_IMAGE_HOSTS`
 * adds hosts without a code change; the built-in defaults cover the image CDNs
 * the crawler currently records.
 *
 * Every rejection is a 400 with a reason rather than a silent empty response —
 * a proxy that fails invisibly is indistinguishable from a proxy that is broken.
 */

import { NextResponse } from 'next/server';

const DEFAULT_ALLOWED_HOSTS = [
  'images.wbstatic.net',
  'cdn.wbbasket.ru',
  'basket-*.wbbasket.ru',
  '*.wildberries.ru',
  '*.wb.ru',
  '*.wildberries.com',
];

function allowedHosts(): string[] {
  const extra = process.env.ALLOWED_IMAGE_HOSTS;
  return extra ? [...DEFAULT_ALLOWED_HOSTS, ...extra.split(',').map((h) => h.trim())] : DEFAULT_ALLOWED_HOSTS;
}

/** Host patterns support a single leading `*.` wildcard, matched on the registrable suffix. */
function hostAllowed(hostname: string, patterns: string[]): boolean {
  const host = hostname.toLowerCase();
  return patterns.some((pattern) => {
    const p = pattern.trim().toLowerCase();
    if (!p) return false;
    if (p.startsWith('*.')) {
      const suffix = p.slice(1); // ".catalog-cdn.ru"
      // Require a label before the suffix: "evilcatalog-cdn.ru" must not match.
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    if (p.includes('*')) {
      // e.g. "basket-*.example-cdn.ru"
      const re = new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]*') + '$');
      return re.test(host);
    }
    return host === p;
  });
}

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get('url');

  if (!raw) {
    return NextResponse.json({ error: 'missing url parameter' }, { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return NextResponse.json({ error: 'malformed url' }, { status: 400 });
  }

  if (parsed.protocol !== 'https:') {
    return NextResponse.json({ error: 'only https is proxied' }, { status: 400 });
  }

  if (!hostAllowed(parsed.hostname, allowedHosts())) {
    return NextResponse.json({ error: `host not allowed: ${parsed.hostname}` }, { status: 400 });
  }

  try {
    const upstream = await fetch(parsed, {
      // Redirects are followed manually so the destination is re-checked against
      // the allowlist — otherwise an allowed host can redirect us anywhere.
      redirect: 'manual',
      signal: AbortSignal.timeout(8_000),
      headers: { Accept: 'image/*' },
    });

    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get('location');
      if (!location) {
        return NextResponse.json({ error: 'redirect without location' }, { status: 502 });
      }
      return GET(new Request(new URL(location, parsed).toString(), { method: 'GET' }));
    }

    if (!upstream.ok || !upstream.body) {
      return NextResponse.json({ error: `upstream ${upstream.status}` }, { status: 502 });
    }

    const contentType = upstream.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) {
      // A host that answers with HTML is either compromised or not a CDN; either
      // way we are not going to hand that document to an <img> and call it a
      // success.
      return NextResponse.json({ error: `unexpected content-type: ${contentType}` }, { status: 502 });
    }

    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
      },
    });
  } catch (err) {
    console.error('[product-image] upstream fetch failed', err);
    return NextResponse.json({ error: 'upstream fetch failed' }, { status: 502 });
  }
}