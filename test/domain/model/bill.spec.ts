import { describe, expect, it } from "vite-plus/test";
import { Bill } from "../../../src/domain/model/bill";
import { Order } from "../../../src/domain/model/order";
import type { GuildRank, MoonPhase } from "../../../src/domain/model/order";
import type { Sku } from "../../../src/domain/model/shop";

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

describe("Bill.from", () => {
  it("totals a small order with no rank, volume, or lunar effect", () => {
    const bill = billFor(
      [
        { sku: "wolfsbane-oil", quantity: 2 },
        { sku: "silver-shot-shell", quantity: 2 },
      ],
      "novice",
      "new-moon",
    );

    expect(bill.lines).toHaveLength(2);
    expect(bill.discountAmount).toBe(0);
    expect(bill.subtotal).toBe(7_548);
    expect(bill.total).toBe(7_548);
  });

  it("adds a lunar surcharge to silver-plated gear during a full moon, but not to plain gear", () => {
    const bill = billFor(
      [
        { sku: "silvered-longsword", quantity: 2 },
        { sku: "wolfsbane-oil", quantity: 3 },
      ],
      "novice",
      "full-moon",
    );

    const [sword, oil] = bill.lines;
    if (sword === undefined || oil === undefined) {
      throw new Error("expected two billed lines");
    }
    expect(sword.lunarRate).toBe(20);
    expect(sword.lunarSurcharge).toBe(19_200);
    expect(sword.lineTotal).toBe(115_200);
    expect(oil.lunarRate).toBe(0);
    expect(oil.lunarSurcharge).toBe(0);
    expect(bill.total).toBe(119_025);
  });

  it("charges a heavier lunar surcharge on silver-plated gear during a lunar eclipse", () => {
    const bill = billFor([{ sku: "silvered-longsword", quantity: 3 }], "novice", "lunar-eclipse");

    const [sword] = bill.lines;
    if (sword === undefined) {
      throw new Error("expected one billed line");
    }
    expect(sword.lunarRate).toBe(50);
    expect(sword.lunarSurcharge).toBe(72_000);
    expect(bill.total).toBe(216_000);
  });

  it("unlocks the rank discount once an order spans enough distinct gear lines", () => {
    const bill = billFor(
      [
        { sku: "blessed-bullets", quantity: 1 },
        { sku: "wolfsbane-oil", quantity: 1 },
        { sku: "silvered-arrowhead", quantity: 1 },
        { sku: "hunter-cloak", quantity: 1 },
        { sku: "silver-shot-shell", quantity: 1 },
      ],
      "master",
      "new-moon",
    );

    expect(bill.rankRate).toBe(10);
    expect(bill.volumeRate).toBe(0);
    expect(bill.total).toBe(18_231);
  });

  it("still applies the volume discount when a high rank doesn't have enough lines to qualify", () => {
    const bill = billFor(
      [
        { sku: "wolfsbane-oil", quantity: 10 },
        { sku: "hunter-cloak", quantity: 15 },
      ],
      "grandmaster",
      "new-moon",
    );

    expect(bill.rankRate).toBe(0);
    expect(bill.volumeRate).toBe(5);
    expect(bill.total).toBe(183_112);
  });

  it("stacks the rank and volume discounts on a large multi-line order", () => {
    const bill = billFor(
      [
        { sku: "blessed-bullets", quantity: 20 },
        { sku: "wolfsbane-oil", quantity: 20 },
        { sku: "silvered-arrowhead", quantity: 20 },
        { sku: "hunter-cloak", quantity: 10 },
        { sku: "silver-shot-shell", quantity: 10 },
      ],
      "master",
      "new-moon",
    );

    expect(bill.discountRate).toBe(22);
    expect(bill.discountAmount).toBe(57_233);
    expect(bill.total).toBe(202_917);
  });

  it("caps the combined discount for a top-rank hunter placing a very large order", () => {
    const bill = billFor(
      [
        { sku: "blessed-bullets", quantity: 15 },
        { sku: "wolfsbane-oil", quantity: 15 },
        { sku: "silvered-arrowhead", quantity: 15 },
        { sku: "hunter-cloak", quantity: 15 },
      ],
      "grandmaster",
      "new-moon",
    );

    // Rank (15%) and volume (12%) would stack to 27%, well past the 25% cap.
    expect(bill.rankRate).toBe(15);
    expect(bill.volumeRate).toBe(12);
    expect(bill.discountRate).toBe(25);
    expect(bill.total).toBe(199_777);
  });

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

    expect(bill.rankRate).toBe(15);
  });

  it("applies the low volume discount at exactly ten total units", () => {
    const bill = billFor([{ sku: "wolfsbane-oil", quantity: 10 }], "novice", "new-moon");

    expect(bill.volumeRate).toBe(5);
  });

  it("applies the high volume discount at exactly fifty total units", () => {
    const bill = billFor([{ sku: "wolfsbane-oil", quantity: 50 }], "novice", "new-moon");

    expect(bill.volumeRate).toBe(12);
  });
});
