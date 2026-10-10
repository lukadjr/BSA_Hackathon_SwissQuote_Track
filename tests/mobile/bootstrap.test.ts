import { expect, it, vi } from 'vitest';

const nativeRandom = vi.hoisted(() => vi.fn());
vi.mock('expo-crypto', () => ({ getRandomValues: nativeRandom }));
vi.mock('expo-router/entry', () => {
  // Router may load any route first; it must already see native randomness.
  expect(globalThis.crypto.getRandomValues).toBe(nativeRandom);
  return {};
});

it('initializes randomness before Expo Router evaluates routes', async () => {
  const existing = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    await import('../../apps/mobile/index');
    expect(globalThis.crypto.getRandomValues).toBe(nativeRandom);
  } finally {
    if (existing) Object.defineProperty(globalThis, 'crypto', existing);
  }
});
