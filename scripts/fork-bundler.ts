// Standalone ERC-4337 bundler for a LOCAL Sepolia fork, to run the app against
// the fork (e.g. to fast-forward the recovery period). Never for a live network.
//   FORK_RPC_URL=http://127.0.0.1:8545 npm run fork:bundler
import { createTestClient, http, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { startForkBundler } from './lib/forkBundler';

const rpcUrl = process.env.FORK_RPC_URL ?? 'http://127.0.0.1:8545';
const port = Number(process.env.FORK_BUNDLER_PORT ?? 8546);
async function main() {
  const executorKey = generatePrivateKey();
  await createTestClient({
    chain: sepolia,
    mode: 'hardhat',
    transport: http(rpcUrl),
  }).setBalance({
    address: privateKeyToAddress(executorKey),
    value: parseEther('100'),
  });
  const { url } = await startForkBundler({ rpcUrl, executorKey, port });
  console.log(`Fork bundler listening on ${url}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
