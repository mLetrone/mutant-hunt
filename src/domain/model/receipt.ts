import { formatCoins, formatRate } from "../money";
import type { Bill, BilledLine } from "./bill";

/**
 * A printable receipt for a priced order. Built by `Receipt.for`, which takes
 * the finished `Bill` and turns every already-computed number into the lines
 * a hunter would actually see on paper.
 */
export class Receipt {
  private constructor(private readonly renderedLines: readonly string[]) {}

  /** Renders every section of the bill: the lines, the subtotal, and the discount. */
  public static for(bill: Bill): Receipt {
    const lines: string[] = [];

    for (const line of bill.lines) {
      lines.push(...Receipt.renderLine(line));
    }

    lines.push(`Subtotal ${formatCoins(bill.subtotal)}`);

    if (bill.discountAmount > 0) {
      lines.push(
        `Guild discount ${formatRate(bill.discountRate)} ${formatCoins(0 - bill.discountAmount)}`,
      );
    }

    lines.push(`TOTAL ${formatCoins(bill.total)}`);

    return new Receipt(lines);
  }

  /** The receipt, one printable line per entry, in the order they should be shown. */
  public lines(): readonly string[] {
    return [...this.renderedLines];
  }

  /** Renders one billed line, plus its lunar surcharge line when it has one. */
  private static renderLine(line: BilledLine): readonly string[] {
    const rendered: string[] = [
      `${line.quantity} x ${line.name} @ ${formatCoins(line.unitPrice)} = ${formatCoins(line.lineTotal - line.lunarSurcharge)}`,
    ];

    if (line.lunarSurcharge > 0) {
      rendered.push(
        `    lunar premium ${formatRate(line.lunarRate)} + ${formatCoins(line.lunarSurcharge)}`,
      );
    }

    return rendered;
  }
}
