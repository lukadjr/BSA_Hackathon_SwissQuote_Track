/**
 * Upper bound for a server challenge's expiry, seen from this device: the
 * server's 5-minute lifetime plus slack for a phone or emulator clock that runs
 * behind (a 20 s drift already broke linking with the former 10 s slack).
 */
export const MAX_CHALLENGE_AHEAD_MS = 300_000 + 120_000;
