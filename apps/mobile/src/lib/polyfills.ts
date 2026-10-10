// viem/noble need `crypto.getRandomValues` to create keys. Hermes (React Native)
// does not always provide it, so we plug in the secure one from expo-crypto.
// This file must be imported BEFORE @swissquote/wallet-core.
import { getRandomValues } from 'expo-crypto';

const g = globalThis as { crypto?: { getRandomValues?: unknown } };
if (typeof g.crypto?.getRandomValues !== 'function') {
  g.crypto = { ...(g.crypto ?? {}), getRandomValues };
}
