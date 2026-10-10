# Transactions

`erc20.ts` validates exact token units and encodes transfers. `userOperation.ts` builds and estimates ERC-4337 operations, authenticates/signs locally, tracks submission durably and verifies events/configuration/balances after two confirmations. Uses self-funded Safe ETH; no paymaster.

See [Sepolia runbook](../../../docs/sepolia-transaction.md). RPC-mocked tests use real SDK signing; they do not prove a funded Sepolia transfer or native authentication.
