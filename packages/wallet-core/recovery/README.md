# recovery

- `module.ts`: Candide SocialRecoveryModule addresses (3 days; 3 minutes for
  demos), calls (protect batch, replace guardian, cancel, multiConfirm, finalize),
  EIP-712 approval data and on-chain state reads.
- `client.ts`: approval signing (guardian key or backup phrase), verification, and
  public module calls sent from a local key for the recovering phone.
- `payloads.ts`: strict QR payload parser, the guardian invite message (identical
  to the backend's) and the 4-word code derived from an address.
- Owner-signed changes (`protect`, `cancel-recovery`, `replace-guardian`) go
  through `createSafeWallet().prepareSecurityOperation` / `submitSecurityOperation`.

Full design, cases and tests: [docs/recovery.md](../../../docs/recovery.md).
