import { describe, it, expect } from "vitest";
import { detectImageMimeType } from "../../src/uploads/magic-bytes.js";

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF87A_BYTES = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x01, 0x00]);
const GIF89A_BYTES = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
const WEBP_BYTES = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);

describe("detectImageMimeType (magic bytes)", () => {
  it("PNG signature -> image/png", () => {
    expect(detectImageMimeType(PNG_BYTES)).toBe("image/png");
  });

  it("JPEG signature -> image/jpeg", () => {
    expect(detectImageMimeType(JPEG_BYTES)).toBe("image/jpeg");
  });

  it("GIF87a signature -> image/gif", () => {
    expect(detectImageMimeType(GIF87A_BYTES)).toBe("image/gif");
  });

  it("GIF89a signature -> image/gif", () => {
    expect(detectImageMimeType(GIF89A_BYTES)).toBe("image/gif");
  });

  it("WEBP signature (RIFF + WEBP at offset 8) -> image/webp", () => {
    expect(detectImageMimeType(WEBP_BYTES)).toBe("image/webp");
  });

  it("disguise: plain text content, even if the caller claims an image extension/Content-Type -> null (only the bytes are trusted)", () => {
    const fakeImageClaim = { filename: "totally-a.png", contentType: "image/png" };
    const bytes = new TextEncoder().encode("<html>not an image at all</html>");
    expect(detectImageMimeType(bytes)).toBe(null);
    // fakeImageClaim above is documentation only: the function signature doesn't accept such metadata, which is exactly what this test
    // verifies: the detection result is independent of any external claim.
    void fakeImageClaim;
  });

  it("truncated header: only the first 3 bytes of the PNG signature -> null", () => {
    expect(detectImageMimeType(Uint8Array.from([0x89, 0x50, 0x4e]))).toBe(null);
  });

  it("truncated header: only the RIFF prefix of WEBP, shorter than offset 8 + WEBP -> null", () => {
    expect(detectImageMimeType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00]))).toBe(null);
  });

  it("empty buffer -> null", () => {
    expect(detectImageMimeType(Uint8Array.from([]))).toBe(null);
  });

  it("RIFF container that is not WEBP (e.g. AVI: offset 8 is AVI, not WEBP) -> null", () => {
    const aviLike = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x01, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20]);
    expect(detectImageMimeType(aviLike)).toBe(null);
  });

  it("GIF88a (version byte is '8', not a valid '7'/'9') -> null", () => {
    expect(detectImageMimeType(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x38, 0x61]))).toBe(null);
  });

  it("GIF89b (suffix byte is 'b', not a valid 'a') -> null", () => {
    expect(detectImageMimeType(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x62]))).toBe(null);
  });

  it("JPEG first 2 bytes match but the 3rd byte is not FF -> null", () => {
    expect(detectImageMimeType(Uint8Array.from([0xff, 0xd8, 0x00, 0x00]))).toBe(null);
  });
});
