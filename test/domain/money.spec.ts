import { describe, expect, it } from "vite-plus/test";
import { applyRate, multiply, percent, silverCoin, sum } from "../../src/domain/money";

describe("silverCoin", () => {
  it("accepts a normal integer amount", () => {
    expect(silverCoin(48_000)).toBe(48_000);
  });

  it("rejects a negative amount", () => {
    expect(() => silverCoin(-50)).toThrowError();
  });

  it("rejects a non-integer amount", () => {
    expect(() => silverCoin(12.7)).toThrowError();
  });
});

describe("percent", () => {
  it("accepts a normal integer percentage", () => {
    expect(percent(12)).toBe(12);
  });

  it("rejects a non-integer percentage", () => {
    expect(() => percent(12.5)).toThrowError();
  });

  it("rejects a negative percentage", () => {
    expect(() => percent(-5)).toThrowError();
  });
});

describe("applyRate", () => {
  it("scales an amount by a rate", () => {
    expect(applyRate(silverCoin(10_000), percent(20))).toBe(2_000);
  });

  it("rounds half up", () => {
    expect(applyRate(silverCoin(333), percent(50))).toBe(167);
  });
});

describe("multiply", () => {
  it("scales a unit price by a quantity", () => {
    expect(multiply(silverCoin(1_275), 4)).toBe(5_100);
  });
});

describe("sum", () => {
  it("adds a list of amounts", () => {
    expect(sum([silverCoin(1_133), silverCoin(2_499), silverCoin(48_000)])).toBe(51_632);
  });
});
