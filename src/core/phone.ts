/** Indian mobile numbers, shared by every store's OTP login. */

/**
 * The 10-digit mobile number in `phone`, or null. Spaces and dashes are ignored and one leading
 * +91 / 91 / 0 is dropped; anything else must already be exactly 10 digits starting 6–9, so a typo
 * (an extra digit) is rejected rather than trimmed into somebody else's number.
 */
export function indianMobile(phone: string): string | null {
  const digits = String(phone)
    .replace(/\D/g, "")
    .replace(/^(91|0)(?=\d{10}$)/, "");
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

export const maskPhone = (phone?: string | null) => (phone ? `******${String(phone).slice(-4)}` : null);
