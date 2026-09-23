import { describe, expect, it } from "vite-plus/test";
import { Bill, Order, Receipt } from "../src/index";
import type { GuildRank, MoonPhase, OrderLine } from "../src/index";

/** Builds a valid `Order` from lines known to pass validation, skipping the ok/problems dance in every test. */
function orderFrom(lines: readonly OrderLine[], rank: GuildRank, moonPhase: MoonPhase): Order {
  const result = Order.create(lines, rank, moonPhase);
  if (!result.ok) {
    throw new Error("expected a valid order");
  }
  return result.order;
}

describe("hunting gear checkout", () => {
  it("bills a well-stocked hunt under a full moon, with a guild discount and a lunar premium", () => {
    const order = orderFrom(
      [
        { sku: "silvered-longsword", quantity: 4 },
        { sku: "silver-shot-shell", quantity: 5 },
        { sku: "wolfsbane-oil", quantity: 4 },
        { sku: "hunter-cloak", quantity: 4 },
      ],
      "master",
      "full-moon",
    );
    const bill = Bill.from(order);
    const receipt = Receipt.for(bill);

    expect(bill.discountRate).toBe(15);
    expect(bill.total).toBe(253_720);
    expect(receipt.lines().length).toBeGreaterThan(0);
  });

  it("bills a light restock with no guild discount and no lunar premium", () => {
    const order = orderFrom(
      [
        { sku: "blessed-bullets", quantity: 4 },
        { sku: "wolfsbane-oil", quantity: 3 },
      ],
      "novice",
      "new-moon",
    );
    const bill = Bill.from(order);
    const receipt = Receipt.for(bill);

    expect(bill.discountAmount).toBe(0);
    expect(bill.total).toBe(17_225);
    expect(receipt.lines().length).toBeGreaterThan(0);
  });

  it("rejects a hunt order that lists the same gear on two separate lines", () => {
    const result = Order.create(
      [
        { sku: "blessed-bullets", quantity: 4 },
        { sku: "blessed-bullets", quantity: 6 },
      ],
      "novice",
      "new-moon",
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected a rejected order");
    }
    expect(result.problems.some((problem) => problem.code === "duplicate-sku")).toBe(true);
  });

  it("prints each line's own total, a lunar premium only for the silver-plated line, and no guild discount line when none applies", () => {
    const order = orderFrom(
      [
        { sku: "wolfsbane-oil", quantity: 2 },
        { sku: "silvered-arrowhead", quantity: 2 },
      ],
      "novice",
      "full-moon",
    );
    const bill = Bill.from(order);
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
    const order = orderFrom(
      [
        { sku: "blessed-bullets", quantity: 1 },
        { sku: "wolfsbane-oil", quantity: 1 },
        { sku: "hunter-cloak", quantity: 1 },
      ],
      "grandmaster",
      "new-moon",
    );
    const bill = Bill.from(order);
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
