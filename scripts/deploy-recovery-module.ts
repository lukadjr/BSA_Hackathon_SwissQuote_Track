/**
 * Deploys Candide's SocialRecoveryModule with a custom grace period on Sepolia.
 *
 * The grace period is an immutable constructor argument, so each period is a
 * separate module address. The creation code is taken from the verified
 * 3-minute demo module and only its constructor argument is replaced, then the
 * deployed runtime code is compared byte for byte with that module.
 *
 * Usage: node --import tsx scripts/deploy-recovery-module.ts [seconds]
 * Reads SWISSQUOTE_TREASURY_PRIVATE_KEY and SEPOLIA_RPC_URL from backend/.env.
 * Idempotent: CREATE2 with salt 0 through the Safe singleton factory.
 */
import { loadEnvFile } from 'node:process';
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  getContractAddress,
  http,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

const REFERENCE_MODULE =
  '0x949d01d424bE050D09C16025dd007CB59b3A8c66' as Address;
const REFERENCE_SECONDS = 180n;
const SINGLETON_FACTORY =
  '0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7' as Address;
const SALT = `0x${'00'.repeat(32)}` as Hex;

async function main() {
  loadEnvFile('backend/.env');
  const seconds = BigInt(process.argv[2] ?? '60');
  if (seconds <= 0n || seconds >= 2n ** 32n) throw new Error('Invalid period');
  const key = process.env.SWISSQUOTE_TREASURY_PRIVATE_KEY as Hex | undefined;
  if (!key) throw new Error('SWISSQUOTE_TREASURY_PRIVATE_KEY is missing');
  const transport = http(
    process.env.SEPOLIA_RPC_URL ??
      'https://ethereum-sepolia-rpc.publicnode.com',
  );
  const client = createPublicClient({ chain: sepolia, transport });

  const response = await fetch(
    `https://eth-sepolia.blockscout.com/api/v2/smart-contracts/${REFERENCE_MODULE}`,
  );
  const verified = (await response.json()) as {
    creation_bytecode: Hex;
    constructor_args: string;
    name: string;
  };
  if (
    verified.name !== 'SocialRecoveryModule' ||
    BigInt(`0x${verified.constructor_args}`) !== REFERENCE_SECONDS
  )
    throw new Error('Unexpected reference module');
  const encode = (value: bigint) => value.toString(16).padStart(64, '0');
  if (!verified.creation_bytecode.endsWith(encode(REFERENCE_SECONDS)))
    throw new Error('Unexpected creation code layout');
  const initCode = (verified.creation_bytecode.slice(0, -64) +
    encode(seconds)) as Hex;
  const address = getContractAddress({
    opcode: 'CREATE2',
    from: SINGLETON_FACTORY,
    salt: SALT,
    bytecode: initCode,
  });

  if (!(await client.getCode({ address }))) {
    const account = privateKeyToAccount(key);
    const wallet = createWalletClient({ account, chain: sepolia, transport });
    const hash = await wallet.sendTransaction({
      to: SINGLETON_FACTORY,
      data: concatHex([SALT, initCode]),
    });
    console.log('deploy transaction', hash);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error('Deployment reverted');
  }

  // Same runtime code as the reference module, except the immutable period.
  const [deployed, reference] = await Promise.all([
    client.getCode({ address }),
    client.getCode({ address: REFERENCE_MODULE }),
  ]);
  const swapped = reference
    ?.toLowerCase()
    .replaceAll(encode(REFERENCE_SECONDS), encode(seconds));
  if (!deployed || deployed.toLowerCase() !== swapped)
    throw new Error(
      'Deployed runtime code does not match the reference module',
    );
  console.log(`SocialRecoveryModule (${seconds}s grace period): ${address}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
