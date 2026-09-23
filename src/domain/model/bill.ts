import { applyRate, multiply, percent, silverCoin, sum } from "../money";
import type { BasisPoints, SilverCoin } from "../money";
import { itemFor } from "./shop";
import type { GearItem, Sku } from "./shop";
import type { GuildRank, MoonPhase, Order, OrderLine } from "./order";

/**
 * One order line after pricing: what it cost before and after the lunar
 * surcharge. `lunarRate` is exposed alongside `lunarSurcharge` so a receipt
 * can print "0%" for a mundane item instead of just omitting the line.
 */
export interface BilledLine {
  readonly sku: Sku;
  readonly name: string;
  readonly quantity: number;
  readonly unitPrice: SilverCoin;
  readonly lunarRate: BasisPoints;
  readonly lunarSurcharge: SilverCoin;
  readonly lineTotal: SilverCoin;
}

/**
 * The rank discount rewards loyalty, but only on an order substantial enough
 * to prove it: a hunter topping up a single SKU shouldn't get the same
 * treatment as one restocking a full kit.
 */
const RANK_DISCOUNT_MIN_LINES = 3;

/** Discount rate per guild rank, before the minimum-lines gate is checked. */
const RANK_DISCOUNT: Readonly<Record<GuildRank, BasisPoints>> = {
  novice: percent(0),
  journeyman: percent(5),
  master: percent(10),
  grandmaster: percent(15),
};

/**
 * Two volume tiers. The higher threshold implies the lower one, so only the
 * boundaries themselves need to be recorded here.
 */
const VOLUME_DISCOUNT_LOW_THRESHOLD = 10;
const VOLUME_DISCOUNT_LOW_RATE: BasisPoints = percent(5);
const VOLUME_DISCOUNT_HIGH_THRESHOLD = 50;
const VOLUME_DISCOUNT_HIGH_RATE: BasisPoints = percent(12);

/**
 * Silvered gear is priced richer around a full moon, when monsters are more
 * dangerous to hunt and the shop's silver stock runs low. New moon and
 * waxing crescent carry no surcharge at all.
 */
const LUNAR_SURCHARGE: Readonly<Record<MoonPhase, BasisPoints>> = {
  "new-moon": percent(0),
  "waxing-crescent": percent(0),
  "full-moon": percent(20),
  "lunar-eclipse": percent(50),
};

/**
 * Rank and volume discounts stack, but the shop caps the combined rate so a
 * grandmaster's bulk order can never be discounted away past this fraction
 * of its subtotal.
 */
const DISCOUNT_CAP: BasisPoints = percent(25);

/**
 * A priced order. Built by `Bill.from`, which runs the whole pricing
 * calculation once: a lunar surcharge per line, summed into a subtotal, then
 * a single rank-and-volume discount applied to that subtotal. Every value
 * involved in that calculation is kept on the instance so a receipt can be
 * printed from it without recomputing anything.
 */
export class Bill {
  private constructor(
    private readonly billedLines: readonly BilledLine[],
    private readonly subtotalAmount: SilverCoin,
    private readonly rankRateValue: BasisPoints,
    private readonly volumeRateValue: BasisPoints,
    private readonly discountRateValue: BasisPoints,
    private readonly discountAmountValue: SilverCoin,
    private readonly totalAmount: SilverCoin,
  ) {}

  /** Prices every line of the order, then discounts the resulting subtotal once. */
  public static from(order: Order): Bill {
    const billedLines: readonly BilledLine[] = order.orderLines.map((line: OrderLine): BilledLine =>
      Bill.priceLine(line.sku, line.quantity, order.moonPhase),
    );
    const subtotal: SilverCoin = sum(
      billedLines.map((line: BilledLine): SilverCoin => line.lineTotal),
    );

    const rankRate: BasisPoints = Bill.computeRankRate(order.guildRank, order.lineCount);
    const volumeRate: BasisPoints = Bill.computeVolumeRate(order.totalQuantity);
    const discountRate: BasisPoints = Bill.capDiscountRate(rankRate, volumeRate);
    const discountAmount: SilverCoin = applyRate(subtotal, discountRate);
    const total: SilverCoin = silverCoin(subtotal - discountAmount);

    return new Bill(
      billedLines,
      subtotal,
      rankRate,
      volumeRate,
      discountRate,
      discountAmount,
      total,
    );
  }

  /** The priced lines, in the order the hunter requested them. */
  public get lines(): readonly BilledLine[] {
    return [...this.billedLines];
  }

  /** The sum of every line total, before the rank/volume discount. */
  public get subtotal(): SilverCoin {
    return this.subtotalAmount;
  }

  /** The rank discount rate that applied, zero if the minimum-lines gate was not met. */
  public get rankRate(): BasisPoints {
    return this.rankRateValue;
  }

  /** The volume discount rate that applied, zero below the lowest tier. */
  public get volumeRate(): BasisPoints {
    return this.volumeRateValue;
  }

  /** The rate actually charged against the subtotal: rank plus volume, capped. */
  public get discountRate(): BasisPoints {
    return this.discountRateValue;
  }

  /** The discount rate turned into an amount, rounded once against the subtotal. */
  public get discountAmount(): SilverCoin {
    return this.discountAmountValue;
  }

  /** The subtotal minus the discount amount: what the hunter owes. */
  public get total(): SilverCoin {
    return this.totalAmount;
  }

  /**
   * Prices one order line. The lunar surcharge is rounded here, per line,
   * so that rounding on one SKU never drifts into another's total.
   */
  private static priceLine(sku: Sku, quantity: number, moonPhase: MoonPhase): BilledLine {
    const item: GearItem = itemFor(sku);
    const base: SilverCoin = multiply(item.unitPrice, quantity);
    // Only silver-plated gear is exposed to the moon; everything else keeps a 0% rate.
    const lunarRate: BasisPoints = item.isSilverPlated ? LUNAR_SURCHARGE[moonPhase] : percent(0);
    const lunarSurcharge: SilverCoin = applyRate(base, lunarRate);
    const lineTotal: SilverCoin = sum([base, lunarSurcharge]);

    return {
      sku: item.sku,
      name: item.name,
      quantity,
      unitPrice: item.unitPrice,
      lunarRate,
      lunarSurcharge,
      lineTotal,
    };
  }

  /** Zero unless the order spans enough distinct SKUs to unlock the rank discount. */
  private static computeRankRate(rank: GuildRank, lineCount: number): BasisPoints {
    if (lineCount < RANK_DISCOUNT_MIN_LINES) {
      return percent(0);
    }
    return RANK_DISCOUNT[rank];
  }

  /** Checked highest tier first, so clearing the high threshold never falls through to the low one. */
  private static computeVolumeRate(totalQuantity: number): BasisPoints {
    if (totalQuantity >= VOLUME_DISCOUNT_HIGH_THRESHOLD) {
      return VOLUME_DISCOUNT_HIGH_RATE;
    }
    if (totalQuantity >= VOLUME_DISCOUNT_LOW_THRESHOLD) {
      return VOLUME_DISCOUNT_LOW_RATE;
    }
    return percent(0);
  }

  /** Stacks rank and volume, then clamps the combined rate to the shop's cap. */
  private static capDiscountRate(rankRate: BasisPoints, volumeRate: BasisPoints): BasisPoints {
    const combined: number = rankRate + volumeRate;
    return (combined > DISCOUNT_CAP ? DISCOUNT_CAP : combined) as BasisPoints;
  }
}
