import {
  SafeAccountV0_3_0,
  SAFE_FALLBACK_HANDLER_STORAGE_SLOT,
} from 'abstractionkit';
import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  isAddressEqual,
  parseAbi,
  zeroAddress,
  type Address,
} from 'viem';
import { sepolia } from 'viem/chains';
import { WalletError } from '../errors';

// Versioned together with abstractionkit 0.4.0. No environment overrides for
// contracts/salt: changing any of them could strand a prefunded account.
export const SAFE_DEPLOYMENT = Object.freeze({
  chainId: 11155111,
  safeVersion: '1.4.1',
  entryPointVersion: '0.7',
  abstractionkitVersion: '0.4.0',
  salt: '0',
  singleton: '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762' as Address,
  factory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67' as Address,
  module: SafeAccountV0_3_0.DEFAULT_SAFE_4337_MODULE_ADDRESS as Address,
  moduleSetup: SafeAccountV0_3_0.DEFAULT_SAFE_MODULE_SETUP_ADDRESS as Address,
  entryPoint: SafeAccountV0_3_0.DEFAULT_ENTRYPOINT_ADDRESS as Address,
});

export interface SepoliaConfig {
  rpcUrl: string;
  bundlerUrl: string;
  tokenAddress: Address;
}

export const safeAbi = parseAbi([
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function VERSION() view returns (string)',
  'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
]);
const SENTINEL = '0x0000000000000000000000000000000000000001';

export function validateConfig(config: SepoliaConfig): SepoliaConfig {
  for (const value of [config.rpcUrl, config.bundlerUrl]) {
    try {
      const url = new URL(value);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error();
    } catch {
      throw new WalletError(
        'CHAIN_CONFIG_INVALID',
        'Configure a Sepolia RPC and bundler URL.',
      );
    }
  }
  if (
    !isAddress(config.tokenAddress, { strict: false }) ||
    isAddressEqual(config.tokenAddress, zeroAddress)
  )
    throw new WalletError(
      'CHAIN_CONFIG_INVALID',
      'Configure a Sepolia test ERC-20 address.',
    );
  return Object.freeze({
    ...config,
    tokenAddress: getAddress(config.tokenAddress),
  });
}

export function initializeSafe(owner: Address) {
  if (
    !isAddress(owner, { strict: false }) ||
    isAddressEqual(owner, zeroAddress)
  )
    throw new WalletError('SAFE_CONFIG_INVALID', 'Invalid owner address.');
  return SafeAccountV0_3_0.initializeNewAccount([getAddress(owner)], {
    threshold: 1,
    c2Nonce: 0n,
    safeAccountFactoryAddress: SAFE_DEPLOYMENT.factory,
    safe4337ModuleAddress: SAFE_DEPLOYMENT.module,
    safeModuleSetupAddress: SAFE_DEPLOYMENT.moduleSetup,
    entrypointAddress: SAFE_DEPLOYMENT.entryPoint,
  });
}

export function predictSafeAddress(owner: Address): Address {
  return getAddress(initializeSafe(owner).accountAddress);
}

export function sepoliaClient(config: SepoliaConfig) {
  return createPublicClient({
    chain: sepolia,
    transport: http(config.rpcUrl, { timeout: 15_000, retryCount: 0 }),
  });
}
export type SepoliaClient = ReturnType<typeof sepoliaClient>;

export async function verifySafe(
  client: SepoliaClient,
  safe: Address,
  owner: Address,
  blockNumber?: bigint,
): Promise<boolean> {
  const code = await client.getCode({ address: safe, blockNumber });
  if (!code || code === '0x') return false;
  const [owners, threshold, version, modules, singleton, handler] =
    await Promise.all([
      client.readContract({
        address: safe,
        abi: safeAbi,
        functionName: 'getOwners',
        blockNumber,
      }),
      client.readContract({
        address: safe,
        abi: safeAbi,
        functionName: 'getThreshold',
        blockNumber,
      }),
      client.readContract({
        address: safe,
        abi: safeAbi,
        functionName: 'VERSION',
        blockNumber,
      }),
      client.readContract({
        address: safe,
        abi: safeAbi,
        functionName: 'getModulesPaginated',
        args: [SENTINEL, 10n],
        blockNumber,
      }),
      client.getStorageAt({ address: safe, slot: '0x0', blockNumber }),
      client.getStorageAt({
        address: safe,
        slot: SAFE_FALLBACK_HANDLER_STORAGE_SLOT,
        blockNumber,
      }),
    ]);
  const storedAddress = (value: string | undefined) =>
    value ? (`0x${value.slice(-40)}` as Address) : zeroAddress;
  if (
    owners.length !== 1 ||
    !isAddressEqual(owners[0], owner) ||
    threshold !== 1n ||
    version !== SAFE_DEPLOYMENT.safeVersion ||
    modules[0].length !== 1 ||
    !isAddressEqual(modules[0][0], SAFE_DEPLOYMENT.module) ||
    !isAddressEqual(modules[1], SENTINEL) ||
    !isAddressEqual(storedAddress(singleton), SAFE_DEPLOYMENT.singleton) ||
    !isAddressEqual(storedAddress(handler), SAFE_DEPLOYMENT.module)
  )
    throw new WalletError(
      'SAFE_CONFIG_INVALID',
      'The deployed Safe configuration does not match this wallet.',
    );
  return true;
}
