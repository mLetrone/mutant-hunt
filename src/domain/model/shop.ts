import { silverCoin, type SilverCoin } from "../money";

export type Sku =
  | "silvered-longsword"
  | "blessed-bullets"
  | "wolfsbane-oil"
  | "silver-shot-shell"
  | "silvered-arrowhead"
  | "hunter-cloak";

export interface GearItem {
  readonly sku: Sku;
  readonly name: string;
  readonly unitPrice: SilverCoin;
  readonly isSilverPlated: boolean;
}

export const CATALOG: Readonly<Record<Sku, GearItem>> = {
  "silvered-longsword": {
    sku: "silvered-longsword",
    name: "Silvered longsword",
    unitPrice: silverCoin(48_000),
    isSilverPlated: true,
  },
  "blessed-bullets": {
    sku: "blessed-bullets",
    name: "Blessed bullets (box of 12)",
    unitPrice: silverCoin(3_350),
    isSilverPlated: false,
  },
  "wolfsbane-oil": {
    sku: "wolfsbane-oil",
    name: "Wolfsbane oil",
    unitPrice: silverCoin(1_275),
    isSilverPlated: false,
  },
  "silver-shot-shell": {
    sku: "silver-shot-shell",
    name: "Silver shot shell",
    unitPrice: silverCoin(2_499),
    isSilverPlated: true,
  },
  "silvered-arrowhead": {
    sku: "silvered-arrowhead",
    name: "Silvered arrowhead",
    unitPrice: silverCoin(1_133),
    isSilverPlated: true,
  },
  "hunter-cloak": {
    sku: "hunter-cloak",
    name: "Hunter's cloak",
    unitPrice: silverCoin(12_000),
    isSilverPlated: false,
  },
};

/** Looks up a catalog entry by SKU. The SKU union keeps this total, not partial. */
export function itemFor(sku: Sku): GearItem {
  return CATALOG[sku];
}
