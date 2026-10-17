// Browser stand-in for Node's "crypto" module (vite.config.js alias). HOT Wallet's library
// (@here-wallet/core) draws its sign-in nonce with crypto.randomBytes; here it comes from the
// browser's secure random generator.
import { Buffer } from 'buffer';

export function randomBytes(size) {
  return Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(size)));
}

export const getRandomValues = (array) => globalThis.crypto.getRandomValues(array);
export const webcrypto = globalThis.crypto;

export default { randomBytes, getRandomValues, webcrypto };
