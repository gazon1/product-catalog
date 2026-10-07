import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The rendered HTML must contain the content, not just a skeleton.
 *
 * ## The defect this catches
 *
 * A root `app/loading.tsx` puts a Suspense boundary around every page. With
 * dynamic rendering, Next.js flushes that skeleton as the initial HTML and
 * delivers the actual markup afterwards as an RSC flight payload. A browser
 * renders it correctly — but the delivered document contains no `<article>` at
 * all, so the site works only with JavaScript enabled.
 *
 * That is not an aesthetic complaint. This site ships `sitemap.xml`, canonical
 * tags and JSON-LD `Product` markup precisely so that a product is findable and
 * interpretable; all of it is wasted if the HTML a crawler fetches is a row of
 * grey placeholder boxes. The same skeleton also made every content assertion
 * in a smoke test read from the flight payload rather than the document.
 *
 * ## What is given up
 *
 * The instant placeholder grid. Every query here is a small indexed read against
 * a local network, so the honest cost is a blank page for a few tens of
 * milliseconds — cheaper than a document that says nothing.
 */
const APP_DIR = resolve(__dirname, '..', 'src', 'app');

describe('no route renders only a skeleton', () => {
  it('has no root loading.tsx', () => {
    // A segment-level `loading.tsx` is a deliberate choice scoped to one route;
    // a root one silently applies to all of them.
    expect(
      readdirSync(APP_DIR),
      'src/app/loading.tsx wraps every page in a Suspense boundary, so the served HTML is a skeleton and the real markup only reaches the browser via the RSC flight payload'
    ).not.toContain('loading.tsx');
  });
});

describe('no component hides content behind client-only rendering', () => {
  const files: string[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx$/.test(entry.name)) files.push(full);
    }
  }
  walk(resolve(__dirname, '..', 'src'));

  it('keeps `use client` to leaf widgets only', () => {
    const clientFiles = files.filter((f) =>
      /^['"]use client['"]/m.test(readFileSync(f, 'utf8').slice(0, 200))
    );
    const paths = clientFiles.map((f) => f.replace(resolve(__dirname, '..') + '/', ''));

    // These are the only components that need to run in the browser. Everything
    // else is a server component, which is what keeps the product list in the
    // document.
    //
    //   ProductImage — an <img> error handler needs component state
    //   error.tsx    — Next requires an error boundary to be a client component
    //
    // Both wrap leaves. A page or a card that becomes a client component takes
    // its subtree out of the server-rendered document with it.
    expect(paths.sort()).toEqual([
      'src/app/error.tsx',
      'src/components/ProductImage.tsx',
    ]);
  });

  it('passes no event handlers from a Server Component', () => {
    // React refuses to serialise an event handler into a Server Component's
    // output. The failure is at render time and takes down the whole document:
    // "Event handlers cannot be passed to Client Component props" replaced the
    // category page with Next's error shell, while the response still carried
    // the page's content inside the RSC flight payload — so a smoke test that
    // only looked for 200s and for database errors saw nothing wrong.
    //
    // The fix belongs here rather than in a comment: a handler reaching a server
    // component is always either a component that should be `'use client'`, or
    // a control that never needed one.
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const isClient = /^['"]use client['"]/m.test(source.slice(0, 200));
      if (isClient) continue;

      const handlers = source.match(/\bon(?:Change|Click|Submit|Input|Focus|Blur|KeyDown)\s*=/g);
      if (handlers) {
        offenders.push(`${file.replace(resolve(__dirname, '..') + '/', '')}: ${handlers.join(', ')}`);
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});