import { describe, expect, it, vi } from "vitest";
import type { Json } from "../src/core/types.js";
import type { PricedCart } from "../src/platforms/zepto/client.js";
import { parseAddresses, parseBill, parseOrder, parseSearch, payOutcome } from "../src/platforms/zepto/parsing.js";
import {
  billProblem,
  findUpiQr,
  listingProblem,
  payZepto,
  UPI_QR,
  zeptoQrbatonOrder,
} from "../src/platforms/zepto/pay.js";
import type { ZeptoSession } from "../src/platforms/zepto/session.js";
import { signRequest } from "../src/platforms/zepto/sign.js";

// Trimmed from live zepto.com responses (2026-10-27).
const SP = "cefcb206-1da2-4cc0-925d-f1d4af3316e9";
const PV = "9d447ba5-1d35-46e1-bc64-e932135d026f";
const STORE = "46b54f69-c5ff-4595-934d-3d98fbf33ec0";

const variant = {
  id: PV,
  formattedPacksize: "1 pack (500 ml)",
  maxAllowedQuantity: 30,
  images: [{ path: "cms/product_variant/2e8a0f88.jpeg" }],
};

const cartResponse = (over: Json = {}): Json => ({
  cartId: "f22a5d45-4561-5b8c-bc86-98b760ccf0d4",
  storeId: STORE,
  grandTotalAmount: 5800,
  toPay: 5800,
  itemTotalAmount: 5800,
  itemTotalAmountPreDiscount: 5800,
  riderTip: 0,
  isDeliverable: true,
  orderLimitBreached: false,
  ordersPerDayLimitBreached: false,
  skusPerDayLimitBreached: [],
  oosProducts: [],
  unserviceableCartProducts: [],
  orderValidationResponse: { isValid: true, failureReasons: [], status: 0 },
  paymentDetails: { paymentFlow: "IPP" },
  encryptedSummary: "eyJ.summary.token",
  fees: [
    { type: "PACKAGING_FEE", title: "Handling Fee", amount: 0, amountPreDiscount: 1000 },
    { type: "DELIVERY_FEE", title: "Delivery Fee ", amount: 0, amountPreDiscount: 3000 },
  ],
  userAddress: { displayText: "Stanza Living Portland House, Gota, Ahmedabad" },
  storeLevelCartProducts: [
    {
      storeId: STORE,
      displayEtaInMin: 6,
      cartProducts: [
        {
          quantity: 2,
          unitFinalSellingPrice: 2900,
          totalUnitFinalSellingPrice: 5800,
          storeProduct: {
            id: SP,
            productVariantId: PV,
            mrp: 2900,
            discountedSellingPrice: 2900,
            product: { name: "Amul Taaza Toned Fresh Milk | Pouch" },
            productVariant: variant,
          },
        },
      ],
    },
  ],
  ...over,
});

const listing = (over: Json = {}): Json => ({
  data: {
    pageLayout: {
      pageMeta: { amountToPay: 5800 },
      widgets: [
        {
          widgetName: "UPI_SECTION_WIDGET",
          data: {
            items: [
              {
                variant: "PAYMENT_VERTICAL_LIST",
                data: [
                  {
                    actionType: "HANDLE_UPI_QR",
                    outageStatus: "UP",
                    paymentInfo: { paymentInstrumentGroup: "UPI", paymentInstrumentCode: "UPI_QR", data: {} },
                    ...over,
                  },
                ],
              },
            ],
          },
        },
      ],
    },
  },
});

describe("request signature", () => {
  it("matches what zepto.com's web app sent", () => {
    // A real GET captured from the browser.
    const h = signRequest({
      method: "GET",
      url: "https://bff-gateway.zepto.com/lms/api/v2/get_page?latitude=12.96902&longitude=77.75395&page_type=HOME&version=v2&show_new_eta_banner=true&page_size=3&enforce_platform_type=DESKTOP",
      requestId: "bd6a05b3-bb5a-4b96-a980-bde3a910c11e",
      deviceId: "f4abbaaf-010b-4845-ae80-ad2f4f37c780",
      secret: "vT1PLhR5hpQZ9ZqINFPHi:4oAitWRA--iIYRMIOOtG25GcxZE.w/A3Q+7vRY6fU5HPaOr7pceBXeXtNsroCe4m0U0dVNE",
    });
    expect(h).toEqual({
      "request-signature": "c44f449d2bab3e885f508738c8de95f7e9461be0efb6787f2e7f7f6e1215286a",
      "x-timezone": "f590b439594753979ef89fb77842a1b652968f4cd6ad66aeccfe06650b0d53e8",
    });
  });

  it("signs the body of a POST", () => {
    const base = { method: "POST", url: "/cfs/api/v1/cart/create", requestId: "r", deviceId: "d", secret: "s" };
    expect(signRequest({ ...base, body: "{}" })).not.toEqual(signRequest({ ...base, body: '{"a":1}' }));
  });
});

describe("parsing", () => {
  it("reads products from search", () => {
    const page = {
      layout: [
        { widgetId: "TITLE_WIDGET" },
        {
          widgetId: "PRODUCT_GRID",
          data: {
            resolver: {
              data: {
                items: [
                  {
                    productResponse: {
                      id: SP,
                      storeId: STORE,
                      mrp: 3000,
                      discountedSellingPrice: 2500,
                      outOfStock: false,
                      availableQuantity: 12,
                      product: { name: "Amul Gold Kool Classic Badam Flavoured Milk", brand: "Amul" },
                      productVariant: variant,
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    };
    expect(parseSearch(page)).toEqual([
      {
        id: PV,
        storeProductId: SP,
        storeId: STORE,
        name: "Amul Gold Kool Classic Badam Flavoured Milk",
        brand: "Amul",
        unit: "1 pack (500 ml)",
        price: 25,
        mrp: 30,
        discountPct: 17,
        inStock: true,
        maxQuantity: 30,
        image: "https://cdn.zeptonow.com/production/cms/product_variant/2e8a0f88.jpeg",
        url: `https://www.zepto.com/pn/amul-gold-kool-classic-badam-flavoured-milk/pvid/${PV}`,
      },
    ]);
  });

  it("reads the bill, with waived fees as struck-out amounts", () => {
    const b = parseBill(cartResponse());
    expect(b.total).toBe(58);
    expect(b.lines).toEqual([
      { type: "ITEM_TOTAL", label: "Item total", amount: 58 },
      { type: "PACKAGING_FEE", label: "Handling Fee", amount: 0, listAmount: 10 },
      { type: "DELIVERY_FEE", label: "Delivery Fee", amount: 0, listAmount: 30 },
    ]);
    expect(b.items).toEqual([
      expect.objectContaining({ id: PV, storeProductId: SP, quantity: 2, price: 29, lineTotal: 58 }),
    ]);
    expect(b).toMatchObject({ etaMinutes: 6, issues: [], walletApplied: 0, paymentFlow: "IPP" });
  });

  it("flags Zepto Cash, stock and limit problems", () => {
    const b = parseBill(
      cartResponse({
        toPay: 3800,
        oosProducts: [{ storeProduct: { product: { name: "Paneer" } } }],
        skusPerDayLimitBreached: [{ name: "Red Bull" }],
        isDeliverable: false,
      }),
    );
    expect(b.walletApplied).toBe(20);
    expect(b.issues).toEqual([
      "Zepto doesn't deliver to this address right now",
      "out of stock: Paneer",
      "daily limit reached for: Red Bull",
    ]);
  });

  it("picks the first address until one is chosen", () => {
    const list = [
      { id: "a1", name: "bhavya", type: "OTHER", displayText: "Stanza Living", latitude: 23.1, longitude: 72.5 },
      { id: "a2", name: "", type: "HOME", displayText: "Home st", latitude: 1, longitude: 2 },
    ];
    expect(parseAddresses(list, undefined).map((a) => [a.label, a.selected])).toEqual([
      ["bhavya", true],
      ["home", false],
    ]);
    expect(parseAddresses(list, "a2").map((a) => a.selected)).toEqual([false, true]);
    expect(parseAddresses(list, "gone").map((a) => a.selected)).toEqual([true, false]);
  });

  it("reads order history", () => {
    const o = {
      id: "01a17d1a-9145-7417-8702-3a0c2b1df618",
      status: "CANCELLED",
      formattedStatus: "CANCELLED",
      grandTotalAmount: 5500,
      placedTime: "2026-10-27T11:27:49.785787Z",
      productsNamesAndCounts: [{ name: "Amul Masti Dahi Cup", count: 1, productVariantId: PV }],
    };
    expect(parseOrder(o)).toEqual({
      orderId: "01a17d1a-9145-7417-8702-3a0c2b1df618",
      status: "CANCELLED",
      amount: 55,
      placedAt: "2026-10-27T11:27:49.785787Z",
      items: [{ name: "Amul Masti Dahi Cup", quantity: 1 }],
    });
  });

  it("maps payment statuses", () => {
    expect(payOutcome("SUCCESS")).toBe("paid");
    expect(payOutcome("FAILED")).toBe("failed");
    expect(payOutcome("PENDING")).toBeNull();
    expect(payOutcome(undefined)).toBeNull();
    expect(payOutcome("payment_success")).toBe("paid");
    expect(payOutcome("CHARGED")).toBe("paid");
  });

  it("never reads a negative or unknown status as paid", () => {
    for (const s of ["PAYMENT_FAILED", "FAILED_NOT_PAID", "REFUNDED", "EXPIRED"]) {
      expect(payOutcome(s)).toBe("failed");
    }
    for (const s of ["UNPAID", "NOT_PAID", "PAYMENT_NOT_COMPLETED", "INCOMPLETE", "PAYMENT_PENDING", "PAIDISH"]) {
      expect(payOutcome(s)).toBeNull();
    }
  });
});

describe("pay guards", () => {
  const bill = parseBill(cartResponse());

  it("needs the exact amount, no wallet, no issues, Zepto's own payment page", () => {
    expect(billProblem(bill, 58)).toBeNull();
    expect(billProblem(bill, 57)).toMatch(/amount to pay is ₹58, not ₹57/);
    expect(billProblem({ ...bill, walletApplied: 5 }, 58)).toMatch(/Zepto Cash/);
    expect(billProblem({ ...bill, issues: ["out of stock: Paneer"] }, 58)).toMatch(/out of stock/);
    expect(billProblem({ ...bill, paymentFlow: "JUSPAY" }, 58)).toMatch(/different payment flow/);
  });

  it("needs Pay via QR Code on the payment page, up, for the same amount", () => {
    expect(findUpiQr(listing())?.paymentInfo.paymentInstrumentCode).toBe("UPI_QR");
    expect(listingProblem(listing(), 58)).toBeNull();
    expect(listingProblem(listing(), 59)).toMatch(/asks for ₹58, expected ₹59/);
    expect(listingProblem(listing({ outageStatus: "DOWN" }), 58)).toMatch(/unavailable/);
    expect(listingProblem(listing({ paymentInfo: { paymentInstrumentCode: "WALLET_PHONEPE" } }), 58)).toMatch(
      /didn't offer "Pay via QR Code"/,
    );
  });

  it("builds the qrbaton order from the bill", () => {
    const o = zeptoQrbatonOrder(bill, "Claude", "ord-1");
    expect(o).toMatchObject({ merchant: "Zepto", agent: "Claude", total: 58, orderId: "ord-1" });
    expect(o.charges).toEqual([
      { label: "Items", amount: 58 },
      { label: "Delivery Fee", amount: 0 },
    ]);
  });
});

describe("pay", () => {
  const priced = (raw = cartResponse()): PricedCart => ({
    bill: parseBill(raw),
    raw,
    request: { storeId: STORE, latitude: 23.1, longitude: 72.5, useZeptoCash: false },
    address: { id: "a1", label: "bhavya", name: null, text: "x", latitude: 23.1, longitude: 72.5, selected: true },
  });
  const session = (api: (method: string, path: string, opts?: Json) => Promise<Json>) =>
    ({ requireLogin() {}, api: vi.fn(api) }) as unknown as ZeptoSession & { api: ReturnType<typeof vi.fn> };

  it("dry run checks the payment page and never creates an order", async () => {
    const s = session(async (_m, path) => (path.includes("payment-listing") ? listing() : {}));
    const r = await payZepto(
      { session: s, price: async () => priced(), clearCart: vi.fn() },
      { confirmAmount: 58, dryRun: true, log: () => {} },
    );
    expect(r.stage).toBe("dry_run_ok");
    expect(s.api.mock.calls.map((c) => c[1])).toEqual(["payment-service/payment-listing-api/v1/ipp"]);
  });

  it("refuses before calling Zepto when Zepto Cash would be used", async () => {
    const s = session(async () => ({}));
    await expect(
      payZepto(
        { session: s, price: async () => priced(cartResponse({ toPay: 3800 })), clearCart: vi.fn() },
        { confirmAmount: 38, log: () => {} },
      ),
    ).rejects.toThrow(/Zepto Cash/);
    expect(s.api).not.toHaveBeenCalled();
  });

  it("orders with the UPI QR as the only instrument and no Zepto Cash", async () => {
    let order: Json;
    const s = session(async (_m, path, opts) => {
      if (path.includes("payment-listing")) return listing();
      if (path === "api/v3/order/") {
        order = opts?.json;
        return { isOrderCreated: true, id: "ord-1", paymentInfo: { paymentInstrumentCode: "WALLET" } };
      }
      return {};
    });
    await expect(
      payZepto(
        { session: s, price: async () => priced(), clearCart: vi.fn() },
        { confirmAmount: 58, handoff: "qr", openPage: false, log: () => {} },
      ),
    ).rejects.toThrow(/instead of a UPI QR/);
    expect(order).toMatchObject({
      useZeptoCash: false,
      previousCartDetails: { toPay: 5800 },
      paymentMetadata: UPI_QR,
      cartId: "f22a5d45-4561-5b8c-bc86-98b760ccf0d4",
    });
  });
});
