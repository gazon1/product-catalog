/**
 * Cashback presentation.
 *
 * `cashback_percent` is the number the source advertises; `cashback` is the ruble amount
 * the crawler derives from the price. They are different units and were briefly
 * stored in one column, which is why both are read and neither is derived here.
 */

export type CashbackTier = 'low' | 'medium' | 'high';

export function cashbackTier(percent: number | null): CashbackTier {
  if (percent === null) return 'low';
  if (percent > 10) return 'high';
  if (percent > 5) return 'medium';
  return 'low';
}

export function cashbackLabel(percent: number | null): string {
  if (percent === null) return '—';
  // One decimal is what the source shows; trailing ",0" reads as false precision.
  const fixed = percent.toFixed(1);
  return `${fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed}%`;
}

/** Tailwind classes per tier. Kept beside the thresholds so the two cannot drift. */
export function cashbackBadgeClass(tier: CashbackTier): string {
  switch (tier) {
    case 'high':
      return 'bg-emerald-100 text-emerald-800 ring-emerald-200';
    case 'medium':
      return 'bg-amber-100 text-amber-900 ring-amber-200';
    case 'low':
      return 'bg-slate-100 text-slate-700 ring-slate-200';
  }
}