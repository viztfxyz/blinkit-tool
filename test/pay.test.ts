import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import QRCode from "qrcode";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Blinkit } from "../src/client.js";
import { paths } from "../src/core/config.js";
import { BlinkitError } from "../src/core/errors.js";
import { handOff, qrbatonOrder, qrbatonStatusFor } from "../src/pay/handoff.js";
import { decodeQrPng, extractUpiIntent, upiIntentFromCapture } from "../src/pay/qr.js";
import { prepareFailureMessage, prepareOrder } from "../src/pay/zpaykit.js";
import type { Cart } from "../src/types.js";

const qrOpts = { type: "png" as const, width: 280, margin: 2, errorCorrectionLevel: "M" as const };

function client(): Blinkit {
  const dir = mkdtempSync(join(tmpdir(), "blinkit-pay-"));
  const bk = new Blinkit(join(dir, "session.json"));
  bk.state.accessToken = "test-token";
  return bk;
}

describe("UPI QR decoding", () => {
  it("decodes a fixture PNG of a upi://pay intent", async () => {
    const intent = "upi://pay?pa=blinkit@paytm&pn=Blinkit&am=99&cu=INR";
    const dir = mkdtempSync(join(tmpdir(), "blinkit-qr-"));
    const file = join(dir, "upi_qr.png");
    writeFileSync(file, await QRCode.toBuffer(intent, qrOpts));
    expect(decodeQrPng(readFileSync(file))).toBe(intent);
  });

  it("ignores QR payloads that are not a UPI intent", async () => {
    const png = await QRCode.toBuffer("https://blinkit.com/checkout", qrOpts);
    expect(decodeQrPng(png)).toBeNull();
    expect(decodeQrPng(Buffer.from("not a png"))).toBeNull();
  });

  it("reads a upi:// string out of frame HTML, including escaped forms", () => {
    expect(extractUpiIntent('<script>q="upi://pay?pa=m@upi&amp;am=99&amp;cu=INR"</script>')).toBe(
      "upi://pay?pa=m@upi&am=99&cu=INR",
    );
    expect(extractUpiIntent(String.raw`upi:\/\/pay?pa=m@upi\u0026am=10`)).toBe("upi://pay?pa=m@upi&am=10");
    expect(extractUpiIntent("<div>no payment here</div>")).toBeNull();
  });

  it("prefers a frame upi:// string, then canvas bytes, then the screenshot PNG", async () => {
    const intentA = "upi://pay?pa=a@upi&pn=A&am=1&cu=INR";
    const intentB = "upi://pay?pa=b@upi&pn=B&am=2&cu=INR";
    const intentC = "upi://pay?pa=c@upi&pn=C&am=3&cu=INR";
    const pngB = await QRCode.toBuffer(intentB, qrOpts);
    const pngC = await QRCode.toBuffer(intentC, qrOpts);
    const other = await QRCode.toBuffer("https://example.com/not-upi", qrOpts);

    expect(upiIntentFromCapture({ text: `<div>${intentA}</div>`, pngs: [pngB.toString("base64")] }, pngC)).toBe(
      intentA,
    );
    expect(upiIntentFromCapture({ text: "<div>no intent</div>", pngs: [pngB.toString("base64")] }, pngC)).toBe(intentB);
    expect(upiIntentFromCapture({ text: "", pngs: [other.toString("base64")] }, pngC)).toBe(intentC);
    expect(upiIntentFromCapture({ text: "nope", pngs: ["not-a-png"] }, pngC)).toBe(intentC);
    expect(upiIntentFromCapture(null, Buffer.from("nope"))).toBeNull();
  });
});

describe("prepareOrder HTTP errors", () => {
  it("names the failing call and includes a body snippet", async () => {
    const bk = client();
    bk.raw = async (_method, path) => {
      if (path.startsWith("/createOrder/"))
        return { status: 500, text: '{"status":"error","reason":"cart has a pending payment"}' };
      throw new Error(`unexpected ${path}`);
    };
    await expect(prepareOrder(bk, "4158271824")).rejects.toThrow(
      'GET /createOrder/4158271824 failed (HTTP 500): {"status":"error","reason":"cart has a pending payment"}',
    );

    const body = `{"reason":"${"x".repeat(400)}"}`;
    bk.raw = async () => ({ status: 500, text: body });
    const err = await prepareOrder(bk, "99").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlinkitError);
    const prefix = "GET /createOrder/99 failed (HTTP 500): ";
    expect((err as BlinkitError).message.startsWith(prefix)).toBe(true);
    expect((err as BlinkitError).message.slice(prefix.length)).toBe(body.slice(0, 200));
  });

  it("names POST /zomato_payment_hash when that call fails", async () => {
    const bk = client();
    bk.raw = async (_method, path) => {
      if (path.startsWith("/createOrder/")) {
        return { status: 200, text: JSON.stringify({ response: { access_token: "pas" }, orderHash: "h" }) };
      }
      if (path === "/zomato_payment_hash") return { status: 500, text: "upstream unavailable" };
      throw new Error(`unexpected ${path}`);
    };
    await expect(prepareOrder(bk, "5")).rejects.toThrow(
      "POST /zomato_payment_hash failed (HTTP 500): upstream unavailable",
    );
  });

  it("keeps a successful prepare and non-HTTP failures unchanged", async () => {
    const bk = client();
    bk.raw = async (_method, path) => {
      if (path.startsWith("/createOrder/")) {
        return { status: 200, text: JSON.stringify({ response: { access_token: "pas" }, orderHash: "hash-1" }) };
      }
      return {
        status: 200,
        text: JSON.stringify({
          zomato_payment_hash_meta: { payment_hash: "ph", order_id: "42", payable_amount: "99" },
        }),
      };
    };
    await expect(prepareOrder(bk, "4158271824")).resolves.toEqual({
      cartId: "4158271824",
      pasToken: "pas",
      orderHash: "hash-1",
      orderId: 42,
      payable: 99,
      paymentHash: "ph",
    });

    bk.raw = async () => ({ status: 200, text: JSON.stringify({ response: {} }) });
    await expect(prepareOrder(bk, "1")).rejects.toThrow(/no PAS token/);

    const loggedOut = new Blinkit(join(mkdtempSync(join(tmpdir(), "blinkit-pay-")), "session.json"));
    await expect(prepareOrder(loggedOut, "1")).rejects.toThrow(/not logged in/);
  });

  it("formats an empty body without a redundant HTTP status", () => {
    expect(prepareFailureMessage("GET /createOrder/1", 500, "  \n", "HTTP 500")).toBe(
      "GET /createOrder/1 failed (HTTP 500)",
    );
    expect(prepareFailureMessage("POST /zomato_payment_hash", 500, "  line1\nline2  ")).toBe(
      "POST /zomato_payment_hash failed (HTTP 500): line1 line2",
    );
  });
});

describe("handoff", () => {
  const intent = "upi://pay?pa=a@upi&am=99&cu=INR";
  const cart: Cart = {
    cartId: 1,
    pricing: "payable",
    items: [
      {
        productId: 1,
        name: "Milk",
        brand: null,
        unit: "1 L",
        quantity: 2,
        price: 40,
        mrp: 45,
        lineTotal: 80,
        maxQuantity: null,
        unavailableQuantity: 0,
        image: "https://cdn.example/m.png",
      },
    ],
    unavailableProducts: [],
    bill: {
      itemsMrp: 90,
      itemsTotal: 80,
      productDiscount: 10,
      deliveryCharge: 0,
      otherCharges: 4,
      chargesBreakdown: { handling_charge: 4 },
      promoDiscount: 0,
      toPay: 84,
      freeDeliveryAbove: null,
    },
    delivery: [{ type: "express", slot: "in 12 minutes", date: "" }],
  };
  paths.qr = join(mkdtempSync(join(tmpdir(), "blinkit-qr-")), "upi_qr.png");
  afterEach(() => vi.unstubAllGlobals());

  it("builds a qrbaton order whose charges add up to the total", () => {
    const o = qrbatonOrder({ cart, amount: 84, agent: "Claude" });
    expect(o).toMatchObject({ merchant: "Blinkit", site: "https://blinkit.com", agent: "Claude", total: 84 });
    expect(o.items[0]).toEqual({
      name: "Milk",
      unit: "1 L",
      qty: 2,
      price: 40,
      mrp: 45,
      image: "https://cdn.example/m.png",
    });
    expect(o.charges.reduce((n, c) => n + c.amount, 0)).toBe(84);
  });

  it("creates a qrbaton pay page from the UPI intent", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "s1", url: "https://qrbaton.example/p/s1", manageToken: "mt" }), {
          status: 201,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await handOff("qrbaton", { cart, amount: 84, upiIntent: intent });
    expect(r).toMatchObject({
      handoff: "qrbaton",
      payLink: "https://qrbaton.example/p/s1",
      sessionId: "s1",
      manageToken: "mt",
      upiIntent: intent,
    });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.upi).toBe(intent);
    expect(body.order.total).toBe(84);
    expect(decodeQrPng(readFileSync(r.qrImage))).toBe(intent);
  });

  it("sends the QR image to qrbaton when the intent is unknown", async () => {
    const png = await QRCode.toBuffer(intent, qrOpts);
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: "s2", url: "https://qrbaton.example/p/s2" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await handOff("qrbaton", { cart, amount: 84, qrPng: png });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.upi).toBeUndefined();
    expect(Buffer.from(body.qr, "base64").equals(png)).toBe(true);
  });

  it("falls back to the plain QR when qrbaton fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 })),
    );
    const r = await handOff("qrbaton", { cart, amount: 84, upiIntent: intent });
    expect(r.handoff).toBe("qr");
    expect(r.payLink).toBeUndefined();
    expect(r.warning).toMatch(/HTTP 429: rate limited/);
  });

  it("qr mode never calls qrbaton", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await handOff("qr", { cart, amount: 84, upiIntent: intent });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r).toEqual({ handoff: "qr", qrImage: paths.qr, upiIntent: intent });
  });

  it("maps terminal stages to qrbaton statuses", () => {
    expect(qrbatonStatusFor("paid")).toBe("paid");
    expect(qrbatonStatusFor("failed")).toBe("failed");
    expect(qrbatonStatusFor("timeout")).toBe("expired");
    expect(qrbatonStatusFor("browser_closed")).toBe("expired");
    expect(qrbatonStatusFor("error")).toBe("expired");
    expect(qrbatonStatusFor("qr_ready")).toBeNull();
    expect(qrbatonStatusFor("dry_run_ok")).toBeNull();
  });
});

describe("payWithUpi fallback", () => {
  it("does not retry in the browser when the confirmed amount is wrong", async () => {
    const { payWithUpi } = await import("../src/pay/index.js");
    const bk = client();
    bk.state.address = { id: 1, label: "Home", text: "x", lat: 1, lon: 1 };
    bk.cart.checkout = async () => ({ bill: { toPay: 120 } }) as Cart;
    const logs: string[] = [];
    await expect(payWithUpi(bk, { confirmAmount: 100, log: (m) => logs.push(m) })).rejects.toThrow(
      /amount to pay is ₹120/,
    );
    expect(logs.join("\n")).not.toMatch(/falling back/);
  });
});
