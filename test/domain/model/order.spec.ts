import { describe, expect, it } from "vite-plus/test";
import { Order } from "../../../src/domain/model/order";

describe("Order.create", () => {
  it("builds an order from valid lines", () => {
    const result = Order.create(
      [
        { sku: "silvered-longsword", quantity: 4 },
        { sku: "wolfsbane-oil", quantity: 25 },
      ],
      "journeyman",
      "full-moon",
    );

    expect(result.ok).toBe(true);
  });

  it("exposes the requested lines, rank, and moon phase", () => {
    const result = Order.create(
      [{ sku: "hunter-cloak", quantity: 4 }],
      "master",
      "waxing-crescent",
    );

    if (!result.ok) {
      throw new Error("expected a valid order");
    }
    expect(result.order.orderLines).toEqual([{ sku: "hunter-cloak", quantity: 4 }]);
    expect(result.order.guildRank).toBe("master");
    expect(result.order.moonPhase).toBe("waxing-crescent");
  });

  it("counts distinct lines and the total quantity across them", () => {
    const result = Order.create(
      [
        { sku: "silvered-longsword", quantity: 4 },
        { sku: "wolfsbane-oil", quantity: 25 },
      ],
      "grandmaster",
      "new-moon",
    );

    if (!result.ok) {
      throw new Error("expected a valid order");
    }
    expect(result.order.lineCount).toBe(2);
    expect(result.order.totalQuantity).toBe(29);
  });

  it("rejects an order with no lines", () => {
    const result = Order.create([], "novice", "new-moon");

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected a rejected order");
    }
    expect(result.problems.map((problem) => problem.code)).toEqual(["empty-order"]);
  });

  it("rejects an order that lists the same sku on two lines", () => {
    const result = Order.create(
      [
        { sku: "blessed-bullets", quantity: 4 },
        { sku: "blessed-bullets", quantity: 25 },
      ],
      "novice",
      "new-moon",
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected a rejected order");
    }
    expect(result.problems.map((problem) => problem.code)).toEqual(["duplicate-sku"]);
  });

  it("rejects a line whose quantity is too low", () => {
    const result = Order.create(
      [{ sku: "silver-shot-shell", quantity: 0 }],
      "novice",
      "lunar-eclipse",
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected a rejected order");
    }
    expect(result.problems.map((problem) => problem.code)).toEqual(["quantity-too-low"]);
  });

  it("rejects a line whose quantity is too high", () => {
    const result = Order.create(
      [{ sku: "silvered-arrowhead", quantity: 150 }],
      "novice",
      "lunar-eclipse",
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected a rejected order");
    }
    expect(result.problems.map((problem) => problem.code)).toEqual(["quantity-too-high"]);
  });
});
