/**
 * The domain's only currency unit. Amounts are integer, non-negative counts of
 * hundredths of silver (so "480.00" is stored as 48000). Marked types are just
 * numbers to the compiler unless every value is born from a validating
 * constructor - `silverCoin` is that constructor, and it is the only legal way
 * to produce one.
 */
export type SilverCoin = number & { readonly __brand: "SilverCoin" };

/**
 * Validates and brands a raw number as a SilverCoin. This is the boundary: once
 * a value has passed through here, every other function in the domain can trust
 * it is a non-negative integer without checking again.
 */
export function silverCoin(value: number): SilverCoin {
  if (!Number.isInteger(value)) {
    throw new Error(`SilverCoin must be an integer, got ${value}`);
  }
  if (value < 0) {
    throw new Error(`SilverCoin must not be negative, got ${value}`);
  }
  return value as SilverCoin;
}

/**
 * A whole-number percentage rate (e.g. 12 for 12%). Every rate in this domain
 * is an integer percentage - there is no fraction of a percent anywhere in the
 * pricing rules - so a plain percentage is all `applyRate` ever needs.
 */
export type Percent = number & { readonly __brand: "Percent" };

/**
 * Validates and brands a raw number as a Percent. This is the boundary: once
 * a value has passed through here, every other function in the domain can
 * trust it is a non-negative integer percentage without checking again.
 */
export function percent(value: number): Percent {
  if (!Number.isInteger(value)) {
    throw new Error(`Percent must be an integer, got ${value}`);
  }
  if (value < 0) {
    throw new Error(`Percent must not be negative, got ${value}`);
  }
  return value as Percent;
}

/**
 * Applies a rate to an amount, rounding half up. Half-up (not banker's rounding,
 * not truncation) is the rounding rule the domain has settled on for money, so it
 * lives here once instead of being re-decided at every call site.
 */
export function applyRate(amount: SilverCoin, rate: Percent): SilverCoin {
  const scaled: number = (amount * rate) / 100;
  return silverCoin(Math.floor(scaled + 0.5));
}

/** Scales a unit price by a quantity. */
export function multiply(unitPrice: SilverCoin, quantity: number): SilverCoin {
  return silverCoin(unitPrice * quantity);
}

/** Adds a list of amounts. Empty input sums to zero. */
export function sum(amounts: readonly SilverCoin[]): SilverCoin {
  return silverCoin(
    amounts.reduce((total: number, amount: SilverCoin): number => total + amount, 0),
  );
}

/**
 * Renders an amount as a fixed two-decimal string, e.g. 48000 -> "480.00".
 *
 * Takes a plain number, not a SilverCoin, on purpose: a receipt prints a
 * discount as a credit, and a SilverCoin is non-negative by construction. The
 * sign belongs to the presentation, not to the amount.
 */
export function formatCoins(amount: number): string {
  const sign: string = amount < 0 ? "-" : "";
  const absolute: number = Math.abs(amount);
  const whole: number = Math.floor(absolute / 100);
  const fraction: string = String(absolute % 100).padStart(2, "0");
  return `${sign}${whole}.${fraction}`;
}

/** Renders a percentage rate, e.g. 12 -> "12%". */
export function formatRate(rate: Percent): string {
  return `${rate}%`;
}
