import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type BrowserCookie, parseNetscape, readCookies, toNetscape, writeCookies } from "../src/amazon/cookies.js";
import { parseBill, parseCart, parseOrder, parseProduct, payOutcome, upiAmount } from "../src/amazon/parsing.js";
import { billProblem, nowQrbatonOrder, type PaymentPageState, paymentPageProblem, payNow } from "../src/amazon/pay.js";
import { NowSession } from "../src/amazon/session.js";
import type { NowBill } from "../src/amazon/types.js";

// Trimmed from live Amazon Now responses (2026-10-27).
const inr = (amount: number) => ({ code: "INR", amount, zero: amount === 0 });
const priced = (amount: number) => ({ displayString: `₹${amount}.00`, currency: inr(amount) });

const purchaseResponse = {
  purchaseId: "404-0000000-0000001",
  billSummary: {
    shortBillSummary: {
      lineItems: [
        { type: "ITEM_TOTAL_TAX_INCLUSIVE", displayLabel: "Items:", listPrice: priced(264), ourPrice: priced(152) },
        { type: "HANDLING_FEE_TAX_INCLUSIVE", displayLabel: null, listPrice: priced(10), ourPrice: priced(0) },
        {
          type: "DELIVERY_FEE_TAX_INCLUSIVE",
          displayLabel: "Delivery Fee:",
          listPrice: priced(30),
          ourPrice: priced(0),
        },
        { type: "PROMOTIONS_APPLIED_TAX_INCLUSIVE", displayLabel: null, listPrice: null, ourPrice: priced(0) },
        { type: "SPECIAL_PAYMENTS_GIFT_CARD_BALANCE", displayLabel: null, listPrice: null, ourPrice: priced(0) },
      ],
    },
  },
  itemSummary: {
    lineItems: [{ asin: "B07BG5GNB5", quantity: 2, ourPrice: priced(76), listPrice: priced(132) }],
  },
  selectedAddress: { lineDisplay: "11, Some Nagar, Bengaluru, KARNATAKA, 560027, India" },
  grandTotal: priced(152),
  statusList: [{ statusType: "INVALID_PAYMENT_METHOD" }],
  preOrderETA: { relativeMinEtaInSeconds: 744 },
};

const cartResponse = {
  cartItems: [
    {
      asin: "B07BG5GNB5",
      title: "Fresh Tender Coconut Water",
      packSize: "1 Pc",
      quantity: 2,
      maxAllowedQuantity: 6,
      available: true,
      availabilityStatus: "IN_STOCK",
      listPrice: inr(132),
      offerPrice: inr(76),
      totalOfferPrice: inr(152),
      productImages: [{ lowResImageUrl: "https://m.media-amazon.com/images/coconut.jpg" }],
    },
  ],
  totalListPrice: inr(264),
  totalOfferPrice: inr(152),
};

describe("Amazon cookie file", () => {
  const cookies: BrowserCookie[] = [
    {
      name: "at-acbin",
      value: "Atza|abc",
      domain: ".amazon.in",
      path: "/",
      expires: 1830000000,
      httpOnly: true,
      secure: true,
    },
    { name: "csm-hit", value: "tb:x", domain: "www.amazon.in", path: "/", expires: -1, httpOnly: false, secure: false },
  ];

  it("round-trips through the Netscape format curl uses, including HttpOnly and session cookies", () => {
    expect(parseNetscape(toNetscape(cookies))).toEqual(cookies);
  });

  it("is written owner-readable only", () => {
    const file = join(mkdtempSync(join(tmpdir(), "anow-")), "amazon-now.cookies");
    writeCookies(file, cookies);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readCookies(file).map((c) => c.name)).toEqual(["at-acbin", "csm-hit"]);
    expect(new NowSession(file).loggedIn).toBe(true);
  });
});

describe("Amazon Now parsing", () => {
  it("reads search results (price) and product lookups (buyingPrice)", () => {
    const fromSearch = parseProduct({
      asin: "B018E0HQPE",
      title: "Amul Taaza Homogenized Toned Milk",
      packSize: "1 L",
      price: { amount: 73 },
      listPrice: inr(77),
      availability: { type: "IN_STOCK" },
      offerId: "offer",
      storeId: "15n6nU",
    });
    expect(fromSearch).toMatchObject({ asin: "B018E0HQPE", price: 73, mrp: 77, discountPct: 5, inStock: true });
    const fromLookup = parseProduct({ asin: "B07BG5GNB5", price: null, buyingPrice: inr(76), listPrice: inr(132) });
    expect(fromLookup).toMatchObject({ price: 76, mrp: 132, inStock: false });
  });

  it("reads the cart", () => {
    expect(parseCart(cartResponse)).toEqual({
      items: [
        {
          asin: "B07BG5GNB5",
          name: "Fresh Tender Coconut Water",
          unit: "1 Pc",
          quantity: 2,
          price: 76,
          mrp: 132,
          lineTotal: 152,
          maxQuantity: 6,
          available: true,
          image: "https://m.media-amazon.com/images/coconut.jpg",
        },
      ],
      itemsMrp: 264,
      itemsTotal: 152,
    });
  });

  it("reads the bill; a missing payment method is not an issue, waived fees keep their list price", () => {
    const b = parseBill(purchaseResponse);
    expect(b).toMatchObject({
      purchaseId: "404-0000000-0000001",
      total: 152,
      issues: [],
      balanceApplied: 0,
      etaMinutes: 12,
    });
    expect(b.lines).toEqual([
      { type: "ITEM_TOTAL_TAX_INCLUSIVE", label: "Items", amount: 152, listAmount: 264 },
      { type: "HANDLING_FEE_TAX_INCLUSIVE", label: "Handling fee", amount: 0, listAmount: 10 },
      { type: "DELIVERY_FEE_TAX_INCLUSIVE", label: "Delivery Fee", amount: 0, listAmount: 30 },
    ]);
  });

  it("sees Amazon Pay balance applied on the bill", () => {
    const withBalance = structuredClone(purchaseResponse);
    withBalance.billSummary.shortBillSummary.lineItems[4].ourPrice = priced(-152);
    expect(parseBill(withBalance).balanceApplied).toBe(152);
  });

  it("reads active orders", () => {
    const o = parseOrder({
      orderId: "407-0000000-0000002",
      paymentDetails: { chargeStatus: "PENDING" },
      deliveryGroups: [
        {
          deliveryTrackingDetails: { header: "Order cancelled", eta: { minETA: 0 } },
          items: [{ asinTitle: "Fresh Tender Coconut Water,1 Pc", quantity: 2 }],
        },
      ],
    });
    expect(o).toEqual({
      orderId: "407-0000000-0000002",
      status: "Order cancelled",
      payment: "PENDING",
      items: [{ name: "Fresh Tender Coconut Water,1 Pc", quantity: 2 }],
      etaMinutes: null,
    });
  });

  it("reads the amount from Amazon's merchant UPI intent", () => {
    const intent =
      "upi://pay?pa=amazonpaygrocery%40apl&pn=Amazon+Pay+Groceries&mc=5411&tid=T1&tr=R1&cu=INR&am=152.00&mode=04&purpose=00&qrMedium=06";
    expect(upiAmount(intent)).toBe(152);
    expect(upiAmount("upi://pay?pa=x@y&cu=INR")).toBeNull();
  });

  it("tells an expired QR from a declined payment (Amazon calls both REJECTED)", () => {
    const expiry = 1_793_084_235;
    const reply = (status: string, terminal: boolean) => ({
      status,
      isTerminalStatus: terminal,
      transactionExpiryTimeout: expiry,
    });
    expect(payOutcome(reply("PENDING", false), expiry * 1000 - 60_000)).toBeNull();
    expect(payOutcome(reply("REJECTED", true), expiry * 1000 + 1000)).toBe("timeout");
    expect(payOutcome(reply("REJECTED", true), expiry * 1000 - 300_000)).toBe("failed");
    expect(payOutcome(reply("SUCCESS", true), expiry * 1000 - 300_000)).toBe("paid");
  });
});

describe("Amazon Now pay guards", () => {
  const bill: NowBill = parseBill(purchaseResponse);

  it("only accepts the exact bill total, with no Amazon Pay balance and no checkout issues", () => {
    expect(billProblem(bill, 152)).toBeNull();
    expect(billProblem(bill, 150)).toMatch(/₹152, not ₹150/);
    expect(billProblem({ ...bill, balanceApplied: 50 }, 152)).toMatch(/Amazon Pay balance/);
    expect(billProblem({ ...bill, issues: ["ITEM_OUT_OF_STOCK"] }, 152)).toMatch(/ITEM_OUT_OF_STOCK/);
  });

  const upi = {
    type: "radio",
    name: "ppw-instrumentRowSelection",
    value:
      "instrumentId=amzn1.pm.pma.upi-VW5pZmllZFBheW1lbnRzSW50ZXJmYWNlOkdlbmVyaWNHdWVzdF9RckNvZGU.X&isExpired=false&paymentMethod=UnifiedPaymentsInterface&tfxEligible=false",
    label: "Scan and Pay with You will need to Scan the QR code on the payment page to complete the payment.",
  };
  const balanceRadio = {
    type: "radio",
    name: "ppw-instrumentRowSelection",
    value: "gcInstrumentId=0h_PE_CUS_x",
    label: "Use 152.00 of your 550.19 Amazon Pay Balance",
  };
  const page = (checked: PaymentPageState["checked"], over: Partial<PaymentPageState> = {}): PaymentPageState => ({
    checked,
    orderTotal: 152,
    payButtons: ["Pay ₹152.00"],
    ...over,
  });

  it("allows Pay only with Scan & Pay UPI as the sole selection, for the confirmed amount", () => {
    expect(paymentPageProblem(page([upi]), 152)).toBeNull();
  });

  it("refuses when Amazon Pay balance is selected (Amazon's default on this page)", () => {
    expect(paymentPageProblem(page([balanceRadio]), 152)).toMatch(/Amazon Pay balance is selected/);
    const apbBox = { type: "checkbox", name: "ppw-APBSelection", value: "gcInstrumentId=0h_PE_CUS_x", label: "" };
    expect(paymentPageProblem(page([upi, apbBox]), 152)).toMatch(/Amazon Pay balance is selected/);
  });

  it("refuses another method, a different total, or a mislabelled Pay button", () => {
    const card = {
      type: "radio",
      name: "ppw-instrumentRowSelection",
      value: "instrumentId=card",
      label: "Visa ending in 1234",
    };
    expect(paymentPageProblem(page([card]), 152)).toMatch(/expected only "Scan and Pay with UPI"/);
    expect(paymentPageProblem(page([]), 152)).toMatch(/found: nothing/);
    expect(paymentPageProblem(page([upi], { orderTotal: 160 }), 152)).toMatch(/total is ₹160/);
    expect(paymentPageProblem(page([upi], { payButtons: ["Pay ₹160.00"] }), 152)).toMatch(/no "Pay ₹152.00" button/);
  });

  it("refuses before opening a browser when the bill would use balance", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "anow-")), "amazon-now.cookies");
    writeCookies(file, [
      { name: "at-acbin", value: "x", domain: ".amazon.in", path: "/", expires: -1, httpOnly: true, secure: true },
    ]);
    const cart = vi.fn();
    await expect(
      payNow(
        { session: new NowSession(file), checkout: async () => ({ ...bill, balanceApplied: 152 }), cart },
        { confirmAmount: 152, log: () => undefined },
      ),
    ).rejects.toThrow(/Amazon Pay balance/);
    expect(cart).not.toHaveBeenCalled();
  });

  it("builds the qrbaton order summary from the bill and cart", () => {
    const order = nowQrbatonOrder(bill, parseCart(cartResponse), "Claude");
    expect(order).toMatchObject({
      merchant: "Amazon Now",
      agent: "Claude",
      total: 152,
      items: [{ name: "Fresh Tender Coconut Water", unit: "1 Pc", qty: 2, price: 76, mrp: 132 }],
      charges: [
        { label: "Items", amount: 264 },
        { label: "Saved on MRP", amount: -112 },
        { label: "Delivery Fee", amount: 0 },
      ],
      orderId: "404-0000000-0000001",
    });
  });
});
