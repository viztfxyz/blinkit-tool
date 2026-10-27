export { HandcartError, type HandcartErrorInfo } from "./core/errors.js";
export { group, type MatchableProduct, type MatchGroup, type TaggedProduct } from "./core/match.js";
export * from "./core/types.js";
export { createServer, runMcp } from "./mcp/server.js";
export {
  HANDOFFS,
  type Handoff,
  type PayOptions,
  type PayStage,
  type PayStatus,
  payWithUpi,
  type QrbatonOrder,
  qrbatonOrder,
  readPayStatus,
} from "./pay/index.js";
/** Blinkit's own option shapes; the shared ones in `core/types.ts` own the unprefixed names. */
export type {
  BrowseResult as BlinkitBrowseResult,
  SearchOptions as BlinkitSearchOptions,
  Where,
} from "./platforms/blinkit/catalog.js";
export { Blinkit } from "./platforms/blinkit/client.js";
export type {
  BlinkitAddress,
  BlinkitBill,
  BlinkitCart,
  BlinkitCartLine,
  BlinkitProduct,
  BlinkitProductDetails,
  LineOutcome,
  Pricing,
  SelectedAddress,
  SessionState,
} from "./platforms/blinkit/types.js";
export {
  CAPABILITIES,
  type Capability,
  can,
  client,
  descriptor,
  type FanOut,
  type FanOutFailure,
  fanOut,
  type Platform,
  type PlatformDescriptor,
  platforms,
  supporting,
} from "./platforms/registry.js";
