import { describe, expect, it } from "vitest";
import { indianMobile, maskPhone } from "../src/core/phone.js";

describe("indianMobile", () => {
  it("accepts a 10-digit mobile, with or without +91 / 91 / 0 and separators", () => {
    for (const p of ["9876543210", "+91 98765 43210", "919876543210", "09876543210", "+91-98765-43210"]) {
      expect(indianMobile(p)).toBe("9876543210");
    }
  });

  it("rejects typos instead of trimming them into another number", () => {
    expect(indianMobile("98765432101")).toBeNull(); // 11 digits, no prefix
    expect(indianMobile("+91 98765 432101")).toBeNull();
    expect(indianMobile("+1 9876543210")).toBeNull();
    expect(indianMobile("987654321")).toBeNull();
    expect(indianMobile("5876543210")).toBeNull(); // not a mobile series
    expect(indianMobile("")).toBeNull();
  });
});

describe("maskPhone", () => {
  it("keeps only the last four digits", () => {
    expect(maskPhone("9876543210")).toBe("******3210");
    expect(maskPhone(undefined)).toBeNull();
  });
});
