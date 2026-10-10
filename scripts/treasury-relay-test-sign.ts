// Local acceptance bridge. Ephemeral test key arrives on stdin, never in argv/logs.
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import {
  buildSafeRelayTransaction,
  safeTransactionTypedData,
} from '../packages/wallet-core/transactions/safeTransaction';

async function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const account = privateKeyToAccount(input.key);
  const transaction = buildSafeRelayTransaction(
    input.calls.map(([to, data]: [string, string]) => ({
      to,
      data,
      value: 0n,
    })),
    BigInt(input.nonce),
  );
  process.stdout.write(
    JSON.stringify({
      chain_id: 11155111,
      safe_address: input.safe,
      owner_address: account.address,
      kind: input.kind,
      transaction,
      signature: await account.signTypedData(
        safeTransactionTypedData(input.safe, transaction),
      ),
    }),
  );
}
main().catch(() => {
  console.error('Test signature bridge failed.');
  process.exit(1);
});
