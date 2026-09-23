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
});
