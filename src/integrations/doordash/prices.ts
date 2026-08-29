const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const formatCents = (cents: number): string => {
  const dollars = cents / 100;
  return `$${dollars.toFixed(cents % 100 === 0 ? 0 : 2)}`;
};

export const doorDashPriceCents = (price: unknown): number | null => {
  const record = asRecord(price);
  if (typeof record?.unit_amount === 'number') return record.unit_amount;
  if (typeof price !== 'number' || !Number.isFinite(price)) return null;
  if (!Number.isInteger(price)) return Math.round(price * 100);
  return price >= 100 ? price : Math.round(price * 100);
};

export const summarizeMenuItemPrice = (
  price: unknown,
  priceDisplay: string | null | undefined,
): { priceCents: number | null; priceDisplay: string | null } => {
  const cents = doorDashPriceCents(price);
  if (typeof priceDisplay === 'string' && priceDisplay.trim()) {
    return { priceCents: cents, priceDisplay: priceDisplay.trim() };
  }
  if (cents === null) return { priceCents: null, priceDisplay: null };
  return { priceCents: cents, priceDisplay: formatCents(cents) };
};
