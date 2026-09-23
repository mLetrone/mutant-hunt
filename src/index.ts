/**
 * The package's public API. Everything a consumer needs to place an order,
 * price it, and print a receipt - nothing else. Kept free of logic on
 * purpose: this file only re-exports what the domain already defines.
 */

export {
  applyRate,
  formatCoins,
  formatRate,
  multiply,
  percent,
  silverCoin,
  sum,
} from "./domain/money";
export type { Percent, SilverCoin } from "./domain/money";

export { Order } from "./domain/model/order";
export type { GuildRank, MoonPhase, OrderLine, OrderProblem } from "./domain/model/order";

export type { Sku } from "./domain/model/shop";

export { Bill } from "./domain/model/bill";
export type { BilledLine } from "./domain/model/bill";

export { Receipt } from "./domain/model/receipt";
