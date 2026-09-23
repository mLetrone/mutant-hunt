import type { Sku } from "./shop";

/** A hunter's guild standing. Bill will look this up for its rank discount. */
export type GuildRank = "novice" | "journeyman" | "master" | "grandmaster";

/** The moon phase at order time. Bill will look this up for its lunar surcharge. */
export type MoonPhase = "new-moon" | "waxing-crescent" | "full-moon" | "lunar-eclipse";

/** One requested SKU and how many units of it. */
export interface OrderLine {
  readonly sku: Sku;
  readonly quantity: number;
}

/** A code identifying why an order was rejected, plus a message meant for humans. */
export interface OrderProblem {
  readonly code: "empty-order" | "duplicate-sku" | "quantity-too-low" | "quantity-too-high";
  readonly message: string;
}

/** The result of `Order.create`: either a valid order, or the problems that block it. */
export type OrderResult =
  | { readonly ok: true; readonly order: Order }
  | { readonly ok: false; readonly problems: readonly OrderProblem[] };

const MIN_QUANTITY = 1;
const MAX_QUANTITY = 99;

/**
 * A hunter's request: what gear, how much of it, under which guild rank and moon
 * phase. The constructor is private so that every `Order` in existence has already
 * passed validation - callers go through `Order.create` and get a result, never an
 * exception, because a malformed order is an expected outcome, not a bug.
 */
export class Order {
  private constructor(
    private readonly lines: readonly OrderLine[],
    private readonly rank: GuildRank,
    private readonly phase: MoonPhase,
  ) {}

  /** Validates the request and either builds an `Order` or reports why it can't. */
  public static create(
    lines: readonly OrderLine[],
    rank: GuildRank,
    moonPhase: MoonPhase,
  ): OrderResult {
    const problems: OrderProblem[] = collectProblems(lines);
    if (problems.length > 0) {
      return { ok: false, problems };
    }
    return { ok: true, order: new Order(lines, rank, moonPhase) };
  }

  /** The requested lines, one per distinct SKU. */
  /**
   * A copy, not the stored array. `readonly` is erased at runtime, so handing
   * the array back by reference would let a caller mutate an order that has
   * already been validated - and the whole point of the private constructor is
   * that an `Order` which exists is an `Order` that holds.
   */
  public get orderLines(): readonly OrderLine[] {
    return [...this.lines];
  }

  /** The hunter's guild rank, for Bill's rank discount. */
  public get guildRank(): GuildRank {
    return this.rank;
  }

  /** The moon phase at order time, for Bill's lunar surcharge. */
  public get moonPhase(): MoonPhase {
    return this.phase;
  }

  /** The number of distinct SKUs on the order. */
  public get lineCount(): number {
    return this.lines.length;
  }

  /** The total number of units across every line. */
  public get totalQuantity(): number {
    return this.lines.reduce((total: number, line: OrderLine): number => total + line.quantity, 0);
  }
}

/** Runs every validation rule and gathers whatever problems apply. */
function collectProblems(lines: readonly OrderLine[]): OrderProblem[] {
  const problems: OrderProblem[] = [];

  if (lines.length === 0) {
    problems.push({ code: "empty-order", message: "An order must contain at least one line" });
  }

  const seenSkus: Set<Sku> = new Set();
  for (const line of lines) {
    if (seenSkus.has(line.sku)) {
      problems.push({
        code: "duplicate-sku",
        message: `Sku "${line.sku}" appears on more than one line`,
      });
    }
    seenSkus.add(line.sku);

    if (line.quantity < MIN_QUANTITY) {
      problems.push({
        code: "quantity-too-low",
        message: `Quantity for "${line.sku}" must be at least ${MIN_QUANTITY}, got ${line.quantity}`,
      });
    }
    if (line.quantity > MAX_QUANTITY) {
      problems.push({
        code: "quantity-too-high",
        message: `Quantity for "${line.sku}" must be at most ${MAX_QUANTITY}, got ${line.quantity}`,
      });
    }
  }

  return problems;
}
