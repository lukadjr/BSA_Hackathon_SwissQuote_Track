# Optional high-value guard

`HighValueGuard.sol` is merged and tested against Safe 1.4.1 on a real local EVM.
It is **not installed by wallet creation/protection and not exposed in the phone
UI**. The phone relay accepts one owner signature; it has no compliance
co-signature provider. The default mobile flow remains independent of this guard.

Constructor:

```solidity
HighValueGuard(address swissquoteSigner, uint256 nativeThresholdWei,
               address token, uint256 tokenThresholdUnits)
```

Use an EOA as the co-signer, a deployed configured token, and positive thresholds.
ETH and token units are separate: e.g. `0.1 ether` and `10_000 * 10**6` test USDC.
Transfers **at or above** their threshold require exactly 130 signature bytes:
owner signature first, then the bank's standard EIP-712 SafeTx signature. Both
sign the same Safe/chain/nonce/target/value/calldata/gas fields. The guard reads
`Safe.nonce()-1` because Safe increments it before the guard hook. It checks
low-s, v=27/28 and the recovered bank address. ERC-165 support lets Safe install it.

Direct low-value configured-token `transfer` and native transfers to EOAs are
allowed. Approvals, unknown-token calls, arbitrary contract calls, batches,
delegatecalls and guard removal require the bank's real co-signature. This avoids
bypassing the threshold by wrapping a transfer in MultiSend or removing the guard
with an owner-only transaction. The previous branch merely checked the length of
extra bytes; any caller could forge those. That behavior is removed.

Limits:

- This is a **transaction guard**. Safe module calls, including ERC-4337 execution
  through the enabled Safe4337 module and Candide recovery, bypass it. It cannot
  claim universal on-chain transaction policy for this application's Safe.
- It supports the demo's one-owner/threshold-one Safe and EOA bank signatures.
- The limit is per transaction, not a daily budget. Existing token allowances and
  other enabled modules must be reviewed separately.
- Installing it adds dependence on a bank co-signer for administrative/batch and
  high-value owner transactions. Do not install it in the normal bank-offline
  recovery demo. A production policy needs a deliberate independent fallback.
- There is no deployment configuration or mobile/API co-signature integration.
  Testing it on a phone requires a future product integration, not an env switch.

Run with the optional local fixture described in `backend/README.md`:

```bash
FUNDING_EVM_FIXTURE=/tmp/swissquote-funding-evm/fixture.json \
  backend/.venv/bin/python -m pytest backend/tests/test_high_value_guard_local_evm.py -q
```

The test compiles the contract and installs it through a real Safe. It covers
low/high native and ERC-20 transfers, exact threshold, absent/random/wrong signer,
nonce replay, amount tampering, arbitrary calls, approve, MultiSend and guard
removal; the treasury pays every outer transaction and the client EOA stays empty.
