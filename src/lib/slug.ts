/**
 * URL slugs for crawl targets.
 *
 * ## Why there is no `slug` column
 *
 * The storefront owns no schema, so it cannot add one. The tempting alternative
 * — putting the target name straight in the path — breaks on Cyrillic, spaces and
 * punctuation, and `/category/Электроника` is not a URL anyone can share reliably.
 *
 * So the slug is *derived*: every target is read (there are a handful — the table
 * is the set of things a human configured), transliterated in JS, and matched in
 * memory. Two targets whose names collide produce the same slug; `resolveTarget`
 * treats that as "not found" rather than guessing, because rendering the wrong
 * category is worse than a 404.
 *
 * The target id is therefore never in the URL, and a target whose name changes
 * changes its URL. That is an accepted trade for owning no schema: for a
 * read-only catalog this is the right side of the bargain.
 */

const CYRILLIC_MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Transliterate Cyrillic, collapse everything else to single dashes. */
export function slugify(input: string): string {
  const transliterated = Array.from(input.toLowerCase())
    .map((ch) => CYRILLIC_MAP[ch] ?? ch)
    .join('');

  return transliterated
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

/**
 * A target's slug, with a numeric suffix when its name slugifies to nothing.
 *
 * The suffix is derived from the id so it is stable: `Электроника` and `☃` both
 * produce a working, distinct URL instead of an empty segment.
 */
export function targetSlug(name: string, id: string): string {
  const base = slugify(name);
  if (base.length > 0) return base;
  return `target-${id.slice(0, 8)}`;
}

/** Short, human-readable id fragment used in hrefs and cache keys. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * Find the target a slug names, from a list already read from the database.
 *
 * Returns null when nothing matches *or* when two targets match — see the module
 * comment. Callers render that as a 404.
 */
export function resolveTarget<T extends { id: string; name: string }>(
  targets: readonly T[],
  slug: string
): T | null {
  const wanted = slug.toLowerCase();
  const matches = targets.filter((t) => targetSlug(t.name, t.id) === wanted);
  // `noUncheckedIndexedAccess` makes indexing yield `T | undefined`; a match
  // list of exactly one still has to be unwrapped explicitly.
  if (matches.length !== 1) return null;
  return matches[0] ?? null;
}