import { describe, expect, it } from "vite-plus/test";
import { Bill, Order, Receipt, formatCoins, formatRate, percent, silverCoin } from "../src/index";
import type { GuildRank, MoonPhase, Sku } from "../src/index";

/**
 * Act 2: the hunt for the survivors. Act 1 proved every line and branch runs;
 * it never pinned down what the domain actually produces at its edges. Every
 * test below targets one of those unguarded edges - a boundary a mutant can
 * slip through, or an output nobody was reading closely enough to assert on.
 */

/** Builds a `Bill` straight from valid order lines, skipping the ok/problems dance in every test. */
function billFor(
  lines: readonly { sku: Sku; quantity: number }[],
  rank: GuildRank,
  moonPhase: MoonPhase,
): Bill {
  const result = Order.create(lines, rank, moonPhase);
  if (!result.ok) {
    throw new Error("expected a valid order");
  }
  return Bill.from(result.order);
}

describe("Bill discount boundaries", () => {
  it("unlocks the rank discount at exactly three distinct lines", () => {
    const bill = billFor(
      [
        { sku: "blessed-bullets", quantity: 1 },
        { sku: "wolfsbane-oil", quantity: 1 },
        { sku: "hunter-cloak", quantity: 1 },
      ],
      "grandmaster",
      "new-moon",
    );

    expect(bill.rankRate).toBe(1_500);
  });

  it("applies the low volume discount at exactly ten total units", () => {
    const bill = billFor([{ sku: "wolfsbane-oil", quantity: 10 }], "novice", "new-moon");

    expect(bill.volumeRate).toBe(500);
  });

  it("applies the high volume discount at exactly fifty total units", () => {
    const bill = billFor([{ sku: "wolfsbane-oil", quantity: 50 }], "novice", "new-moon");

    expect(bill.volumeRate).toBe(1_200);
  });
});

describe("Order line quantity boundaries", () => {
  it("accepts a line quantity at exactly the minimum and the maximum", () => {
    const result = Order.create(
      [
        { sku: "wolfsbane-oil", quantity: 1 },
        { sku: "hunter-cloak", quantity: 99 },
      ],
      "novice",
      "new-moon",
    );

    expect(result.ok).toBe(true);
  });

  it("reports the exact message for an empty order", () => {
    const result = Order.create([], "novice", "new-moon");

    if (result.ok) {
      throw new Error("expected a rejected order");
    }
    expect(result.problems).toEqual([
      { code: "empty-order", message: "An order must contain at least one line" },
    ]);
  });

  it("reports the exact message for a duplicated sku", () => {
    const result = Order.create(
      [
        { sku: "blessed-bullets", quantity: 4 },
        { sku: "blessed-bullets", quantity: 6 },
      ],
      "novice",
      "new-moon",
    );

    if (result.ok) {
      throw new Error("expected a rejected order");
    }
    expect(result.problems).toEqual([
      { code: "duplicate-sku", message: 'Sku "blessed-bullets" appears on more than one line' },
    ]);
  });

  it("reports the exact message for a quantity below the minimum", () => {
    const result = Order.create([{ sku: "silver-shot-shell", quantity: 0 }], "novice", "new-moon");

    if (result.ok) {
      throw new Error("expected a rejected order");
    }
    expect(result.problems).toEqual([
      {
        code: "quantity-too-low",
        message: 'Quantity for "silver-shot-shell" must be at least 1, got 0',
      },
    ]);
  });

  it("reports the exact message for a quantity above the maximum", () => {
    const result = Order.create(
      [{ sku: "silvered-arrowhead", quantity: 100 }],
      "novice",
      "new-moon",
    );

    if (result.ok) {
      throw new Error("expected a rejected order");
    }
    expect(result.problems).toEqual([
      {
        code: "quantity-too-high",
        message: 'Quantity for "silvered-arrowhead" must be at most 99, got 100',
      },
    ]);
  });
});

describe("SilverCoin validation messages", () => {
  it("reports the exact message for a non-integer amount", () => {
    expect(() => silverCoin(12.7)).toThrowError("SilverCoin must be an integer, got 12.7");
  });

  it("reports the exact message for a negative amount", () => {
    expect(() => silverCoin(-50)).toThrowError("SilverCoin must not be negative, got -50");
  });
});

describe("formatCoins rendering", () => {
  it("prints zero with no sign", () => {
    expect(formatCoins(0)).toBe("0.00");
  });

  it("prints a negative amount with a leading minus sign", () => {
    expect(formatCoins(-1_250)).toBe("-12.50");
  });

  it("left-pads a single-digit fraction with a zero", () => {
    expect(formatCoins(5)).toBe("0.05");
  });
});

describe("formatRate rendering", () => {
  it("renders a basis-points rate as a whole percentage", () => {
    expect(formatRate(percent(12))).toBe("12%");
  });
});

describe("Receipt rendering", () => {
  it("prints every line's own total, a lunar premium only for the surcharged line, and no guild discount when none applies", () => {
    const bill = billFor(
      [
        { sku: "wolfsbane-oil", quantity: 2 },
        { sku: "silvered-arrowhead", quantity: 2 },
      ],
      "novice",
      "full-moon",
    );
    expect(bill.discountAmount).toBe(0);

    const receipt = Receipt.for(bill);

    expect(receipt.lines()).toEqual([
      "2 x Wolfsbane oil @ 12.75 = 25.50",
      "2 x Silvered arrowhead @ 11.33 = 22.66",
      "    lunar premium 20% + 4.53",
      "Subtotal 52.69",
      "TOTAL 52.69",
    ]);
  });

  it("prints the guild discount as a negative credit line, never as a surcharge, when a discount applies", () => {
    const bill = billFor(
      [
        { sku: "blessed-bullets", quantity: 1 },
        { sku: "wolfsbane-oil", quantity: 1 },
        { sku: "hunter-cloak", quantity: 1 },
      ],
      "grandmaster",
      "new-moon",
    );
    expect(bill.discountAmount).toBe(2_494);

    const receipt = Receipt.for(bill);

    expect(receipt.lines()).toEqual([
      "1 x Blessed bullets (box of 12) @ 33.50 = 33.50",
      "1 x Wolfsbane oil @ 12.75 = 12.75",
      "1 x Hunter's cloak @ 120.00 = 120.00",
      "Subtotal 166.25",
      "Guild discount 15% -24.94",
      "TOTAL 141.31",
    ]);
  });
});
