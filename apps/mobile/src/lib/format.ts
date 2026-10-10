// Display helpers. Test USDC is valued 1:1 in USD; Sepolia ETH only pays
// network fees and has no market value, so it never counts in the total.

/** "1234.5" → "$1,234.50" (no Intl dependency, stable across engines). */
export function formatUsd(value: number | string | null | undefined): string {
  const n = typeof value === 'string' ? Number(value) : (value ?? NaN);
  if (!Number.isFinite(n)) return '$—';
  const negative = n < 0;
  const [whole, cents] = Math.abs(n).toFixed(2).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${grouped}.${cents}`;
}

/** Token amount with at most `digits` decimals, trailing zeros removed. */
export function formatAmount(value: string | number, digits = 4): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const fixed = n.toFixed(digits).replace(/\.?0+$/, '');
  const [whole, decimals] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decimals ? `${grouped}.${decimals}` : grouped;
}

/** Portfolio value in USD of the tokens the wallet holds. */
export function portfolioUsd(balances: { usdc: string | null }): number | null {
  if (balances.usdc === null) return null;
  const usdc = Number(balances.usdc);
  return Number.isFinite(usdc) ? usdc : null;
}

/** "2026-10-10T21:14:26Z" → "10 Oct, 21:14" in the phone's time zone. */
export function formatWhen(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const months = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${date.getDate()} ${months[date.getMonth()]}, ${hh}:${mm}`;
}
