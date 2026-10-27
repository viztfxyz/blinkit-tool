import { HandcartError } from "../../core/errors.js";
import type { CartService } from "./cart.js";
import { maskPhone, parseAddress } from "./parsing.js";
import type { Core } from "./session.js";
import type { BlinkitAddress, BlinkitCart, Json, SelectedAddress } from "./types.js";

export interface NewAddress {
  label: string;
  name: string;
  line1: string;
  line2?: string;
  landmark?: string;
  city?: string;
  pincode?: string;
  lat?: number;
  lon?: number;
}

export class Account {
  constructor(
    private core: Core,
    private cart: CartService,
  ) {}

  // ---------- login ----------

  /** Send a login OTP by SMS to a 10-digit Indian mobile number. */
  async requestOtp(phone: string): Promise<{ otpSent: true; message?: string }> {
    const digits = String(phone).replace(/\D/g, "").slice(-10);
    if (!/^[6-9]\d{9}$/.test(digits)) throw new HandcartError("phone must be a 10-digit Indian mobile number");
    const data = await this.core.req("POST", "/v2/accounts/", { form: { user_phone: digits } });
    if (!data.success) throw new HandcartError(data.message || "OTP request rejected");
    this.core.state.pendingPhone = digits;
    this.core.save();
    return { otpSent: true, message: data.message };
  }

  /** Complete login with the code from the SMS. */
  async verifyOtp(code: string, phone?: string) {
    const userPhone = phone ?? this.core.state.pendingPhone;
    if (!userPhone) throw new HandcartError("request an OTP first (`handcart blinkit login <phone>`)");
    const data = await this.core.req("POST", "/v2/accounts/verify/phone/code/", {
      form: { user_phone: userPhone, verify_code: String(code).trim() },
    });
    if (!data.verified || !data.access_token) throw new HandcartError(data.message || "OTP rejected");
    const user = data.user ?? {};
    Object.assign(this.core.state, { accessToken: data.access_token, user: { id: user.id, phone: user.phone } });
    delete this.core.state.pendingPhone;
    delete this.core.state.cartId;
    this.core.save();
    return { loggedIn: true, userId: user.id as number, phone: maskPhone(user.phone ?? userPhone) };
  }

  async logout() {
    if (this.core.loggedIn) await this.core.raw("POST", "/v2/accounts/logout/").catch(() => undefined);
    const { deviceId, location } = this.core.state;
    this.core.state = { deviceId, location, cart: {} };
    this.core.save();
    return { loggedOut: true };
  }

  whoami() {
    const { user, address, location, cartId, cart } = this.core.state;
    return {
      loggedIn: this.core.loggedIn,
      userId: user?.id ?? null,
      phone: maskPhone(user?.phone),
      deliveryAddress: address ?? null,
      deliveryArea: address ? null : (location ?? null),
      pricing: this.cart.pricing,
      cartId: cartId ?? null,
      cartItems: cart,
    };
  }

  // ---------- addresses ----------

  async addresses(): Promise<BlinkitAddress[]> {
    const loc = this.core.currentLocation();
    const q = loc ? `?cur_lat=${loc.lat}&cur_lon=${loc.lon}` : "";
    const data = await this.core.req("GET", `/v4/address${q}`, { needLogin: true });
    return (data.addresses ?? []).map(parseAddress);
  }

  /** Deliver to a saved address (by id, label, or part of its text); reprices the cart for that store. */
  async useAddress(which: string | number): Promise<{ address: SelectedAddress; cart?: BlinkitCart }> {
    const addrs = await this.addresses();
    const w = String(which).trim().toLowerCase();
    const byId = addrs.filter((a) => String(a.id) === w);
    const byLabel = addrs.filter((a) => (a.label ?? "").toLowerCase() === w);
    const byText = addrs.filter((a) => a.text.toLowerCase().includes(w));
    const matches = byId.length ? byId : byLabel.length ? byLabel : byText;
    if (!matches.length) {
      throw new HandcartError(`no saved address matches '${which}'; saved: ${addrs.map((a) => a.label).join(", ")}`);
    }
    if (matches.length > 1) {
      throw new HandcartError(
        `ambiguous; use an id: ${matches.map((a) => `${a.id} (${a.label}: ${a.text.slice(0, 40)})`).join(", ")}`,
      );
    }
    const a = matches[0];
    if (a.lat == null || a.lon == null) throw new HandcartError(`address ${a.id} has no coordinates`);
    this.core.state.address = { id: a.id, label: a.label ?? "", text: a.text, lat: Number(a.lat), lon: Number(a.lon) };
    this.core.save();
    const result: { address: SelectedAddress; cart?: BlinkitCart } = { address: this.core.state.address };
    if (Object.keys(this.core.state.cart).length) result.cart = await this.cart.get();
    return result;
  }

  async addAddress(a: NewAddress): Promise<BlinkitAddress> {
    const loc = await this.core.resolveLocation(a);
    const body: Json = {
      label: a.label,
      title: a.label,
      name: a.name,
      line1: a.line1,
      line2: a.line2,
      landmark: a.landmark,
      city: a.city ?? ("city" in loc ? loc.city : undefined),
      latitude: loc.lat,
      longitude: loc.lon,
      location_source: "map",
    };
    for (const k of Object.keys(body)) if (!body[k]) delete body[k];
    const data = await this.core.req("POST", "/v3/address", { loc, needLogin: true, json: body });
    return parseAddress(data.address ?? data);
  }

  async deleteAddress(addressId: number) {
    await this.core.req("DELETE", `/v3/address/${addressId}`, { needLogin: true });
    if (this.core.state.address?.id === addressId) {
      delete this.core.state.address;
      this.core.save();
    }
    return { deleted: addressId };
  }
}
