# Transactions

`erc20.ts` validates exact token units and encodes transfers.
`safeTransaction.ts` builds ordinary Safe EIP-712 transactions, checks their hash
against the contract, authenticates/signs locally and relays via the configured
Swissquote treasury. It uses Safe.nonce(), zero native value/reimbursement and
pinned MultiSendCallOnly batches. Signed public authorizations survive timeout;
confirmation independently verifies canonical receipts, the indexed Safe hash,
payment=0, token events, owner configuration and balances.

Mobile passes `relay` into `createSafeWallet`, so transfers/security use this path
by default. Client Safe/owner need zero ETH; no bundler/paymaster is required.
`userOperation.ts` retains the separate self-funded ERC-4337 test path when no
relay is injected. That legacy path still needs Safe ETH and is not gasless.

See [phone runbook](../../../docs/xcode-phone-test-handoff.md),
[implementation plan](../../../docs/gasless-implementation-plan.md) and the
optional real HTTP/worker/EVM acceptance in `test_wallet_http_local_evm.py`.
Node and EVM tests do not prove native biometric protection.
