import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import jsQRModule from "jsqr";
import { PNG } from "pngjs";
import QRCode from "qrcode";

type QrDecoder = (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;

/** jsqr's CJS build is the function; its type declarations describe an ESM default. Accept either. */
function qrDecoder(mod: unknown): QrDecoder {
  if (typeof mod === "function") return mod as QrDecoder;
  if (mod && typeof mod === "object" && "default" in mod && typeof mod.default === "function")
    return mod.default as QrDecoder;
  throw new Error("jsqr did not export a decoder");
}

const jsQR = qrDecoder(jsQRModule);
const UPI_INTENT = /upi:\/\/pay\?[^\s"'<>]+/i;

/** HTML / JSON / visible text from the zpaykit frame, plus canvas and img PNGs. */
export interface FrameQrCapture {
  text: string;
  /** Base64 PNGs (no data-URL prefix) read from canvas and img elements. */
  pngs: string[];
}

export function extractUpiIntent(text: string): string | null {
  const normalized = text
    .replace(/\\\//g, "/")
    .replace(/\\u0026/gi, "&")
    .replace(/&amp;/g, "&");
  const match = normalized.match(UPI_INTENT);
  if (!match) return null;
  return match[0].replace(/[),.;]+$/g, "").replace(/^upi:\/\//i, "upi://");
}

/** Decode a PNG QR. Returns the payload only when it is a upi://pay intent. */
export function decodeQrPng(png: Buffer): string | null {
  try {
    const image = PNG.sync.read(png);
    if (!image.width || !image.height || image.data.length < image.width * image.height * 4) return null;
    const pixels = new Uint8ClampedArray(image.width * image.height * 4);
    pixels.set(image.data.subarray(0, pixels.length));
    const code = jsQR(pixels, image.width, image.height);
    return code ? extractUpiIntent(code.data) : null;
  } catch {
    return null;
  }
}

function pngBytes(value: string): Buffer {
  const comma = value.startsWith("data:") ? value.indexOf(",") : -1;
  return Buffer.from(comma >= 0 ? value.slice(comma + 1) : value, "base64");
}

/**
 * Prefer a upi:// string or canvas/img pixels from the zpaykit frame.
 * The screenshot PNG is only used when the frame has neither.
 */
export function upiIntentFromCapture(capture: FrameQrCapture | null | undefined, screenshot?: Buffer): string | null {
  const fromText = capture?.text ? extractUpiIntent(capture.text) : null;
  if (fromText) return fromText;
  for (const png of capture?.pngs ?? []) {
    if (!png) continue;
    const intent = decodeQrPng(pngBytes(png));
    if (intent) return intent;
  }
  return screenshot?.length ? decodeQrPng(screenshot) : null;
}

/** Write a clean QR for the intent, or the captured image when there's no intent, to `path`. */
export async function writeQr(path: string, source: { upiIntent?: string | null; png?: Buffer }): Promise<string> {
  mkdirSync(dirname(path), { recursive: true });
  if (source.upiIntent) {
    await QRCode.toFile(path, source.upiIntent, { type: "png", width: 512, margin: 2, errorCorrectionLevel: "M" });
  } else if (source.png?.length) {
    writeFileSync(path, source.png);
  } else {
    throw new Error("no UPI intent or QR image to write");
  }
  return path;
}
