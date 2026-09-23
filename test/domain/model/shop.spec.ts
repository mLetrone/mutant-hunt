import { describe, expect, it } from "vite-plus/test";
import { CATALOG, itemFor } from "../../../src/domain/model/shop";

describe("CATALOG", () => {
  it("lists every gear SKU exactly once", () => {
    expect(Object.keys(CATALOG).sort()).toEqual(
      [
        "blessed-bullets",
        "hunter-cloak",
        "silver-shot-shell",
        "silvered-arrowhead",
        "silvered-longsword",
        "wolfsbane-oil",
      ].sort(),
    );
  });

  it("keys each entry under its own sku", () => {
    expect(CATALOG["silvered-longsword"].sku).toBe("silvered-longsword");
  });
});

describe("itemFor", () => {
  it("looks up the catalog entry for a sku", () => {
    expect(itemFor("hunter-cloak")).toBe(CATALOG["hunter-cloak"]);
  });
});
