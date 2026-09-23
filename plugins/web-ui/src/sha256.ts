import { sha256 } from "@noble/hashes/sha2.js";

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  let digest: Uint8Array;
  if (subtle) {
    digest = new Uint8Array(await subtle.digest("SHA-256", bytes as unknown as ArrayBuffer));
  } else {
    const hash = sha256.create();
    const chunkSize = 1_048_576;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      hash.update(bytes.subarray(offset, offset + chunkSize));
      if (offset + chunkSize < bytes.length) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    digest = hash.digest();
  }
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
