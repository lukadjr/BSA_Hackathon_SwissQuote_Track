import {
  Bundler,
  HttpTransport,
  SafeAccountV0_3_0,
  calculateUserOperationMaxGasCost,
  createUserOperationHash,
  type UserOperationV7,
} from 'abstractionkit';
import {
  decodeEventLog,
  formatUnits,
  getAddress,
  isAddressEqual,
  parseAbi,
  type Address,
  type Hash,
} from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { WalletError } from '../errors';
import type { OwnerKeyStorage } from '../keys/storage';
import {
  initializeSafe,
  predictSafeAddress,
  SAFE_DEPLOYMENT,
  sepoliaClient,
  validateConfig,
  verifySafe,
  type SepoliaConfig,
} from '../safe/account';
import { encodeTransfer, erc20Abi } from './erc20';

export interface SafeAccountInfo {
  ownerAddress: Address;
  safeAddress: Address;
  deployed: boolean;
  tokenAddress: Address;
  decimals: number;
  tokenBalance: string;
  ethBalance: string;
}
export interface TransferPreview {
  readonly ownerAddress: Address;
  readonly safeAddress: Address;
  readonly tokenAddress: Address;
  readonly recipient: Address;
  readonly amount: string;
  readonly amountUnits: string;
  readonly decimals: number;
  readonly maxGasEth: string;
  readonly deploysSafe: boolean;
  readonly expiresAt: number;
}
export interface SubmittedTransfer {
  ownerAddress: Address;
  safeAddress: Address;
  tokenAddress: Address;
  recipient: Address;
  amountUnits: string;
  decimals: number;
  nonce: string;
  validUntil: string;
  userOperationHash: Hash;
}
export interface ConfirmedTransfer extends SubmittedTransfer {
  transactionHash: Hash;
  explorerUrl: string;
  blockNumber: string;
  senderBalanceBefore: string;
  senderBalanceAfter: string;
  recipientBalanceBefore: string;
  recipientBalanceAfter: string;
  balanceChangesMatch: boolean;
}
/** Public tracking only. Persist before submission to handle an ambiguous timeout. */
export interface TransferActivityStore {
  readPending(): Promise<SubmittedTransfer | null>;
  writePending(value: SubmittedTransfer | null): Promise<void>;
  writeConfirmed(value: ConfirmedTransfer): Promise<void>;
}
const entryPointAbi = parseAbi([
  'function getNonce(address sender, uint192 key) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
]);

function assertActive(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new WalletError(
      'AUTH_CANCELLED',
      'Transfer cancelled before submission.',
    );
}
async function network<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (e) {
    if (e instanceof WalletError) throw e;
    throw new WalletError(
      'NETWORK_FAILED',
      'Sepolia request failed. Check connectivity and configuration.',
    );
  }
}

export function createSafeWallet({
  config: inputConfig,
  storage,
  activity,
}: {
  config: SepoliaConfig;
  storage: OwnerKeyStorage;
  activity: TransferActivityStore;
}) {
  const config = validateConfig(inputConfig);
  const client = sepoliaClient(config);
  // Bounded requests; never forward provider errors (URLs may contain credentials).
  const sdkFetch: typeof fetch = async (input, init) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  };
  const rpc = new HttpTransport(config.rpcUrl, { fetch: sdkFetch });
  const bundler = new Bundler(
    new HttpTransport(config.bundlerUrl, { fetch: sdkFetch }),
  );
  // Prepared operations never leave this closure. Changing UI preview fields
  // cannot change the operation signed after authentication.
  const prepared = new WeakMap<
    TransferPreview,
    {
      operation: UserOperationV7;
      account: SafeAccountV0_3_0;
      preparedAt: number;
      validUntil: bigint;
    }
  >();
  let submitting = false;

  async function ownerAddress(): Promise<Address> {
    const owner = await storage.readAddress();
    if (!owner)
      throw new WalletError(
        'WALLET_NOT_FOUND',
        'Create an owner wallet first.',
      );
    return getAddress(owner);
  }
  async function checkNetwork() {
    const [rpcChain, bundlerChain, supported] = await Promise.all([
      client.getChainId(),
      bundler.chainId(),
      bundler.supportedEntryPoints(),
    ]);
    if (
      rpcChain !== SAFE_DEPLOYMENT.chainId ||
      BigInt(bundlerChain) !== BigInt(SAFE_DEPLOYMENT.chainId) ||
      !supported.some((value) =>
        isAddressEqual(getAddress(value), SAFE_DEPLOYMENT.entryPoint),
      )
    )
      throw new WalletError(
        'CHAIN_CONFIG_INVALID',
        'RPC and bundler must support Sepolia and EntryPoint v0.7.',
      );
    const addresses = [
      SAFE_DEPLOYMENT.singleton,
      SAFE_DEPLOYMENT.factory,
      SAFE_DEPLOYMENT.module,
      SAFE_DEPLOYMENT.moduleSetup,
      SAFE_DEPLOYMENT.entryPoint,
      config.tokenAddress,
    ];
    const codes = await Promise.all(
      addresses.map((address) => client.getCode({ address })),
    );
    if (codes.some((code) => !code || code === '0x'))
      throw new WalletError(
        'CHAIN_CONFIG_INVALID',
        'A required Safe or token contract is missing on Sepolia.',
      );
  }
  async function getAccount(): Promise<SafeAccountInfo> {
    return network(async () => {
      await checkNetwork();
      const owner = await ownerAddress();
      const safe = predictSafeAddress(owner);
      const [deployed, decimals, balance, eth] = await Promise.all([
        verifySafe(client, safe, owner),
        client.readContract({
          address: config.tokenAddress,
          abi: erc20Abi,
          functionName: 'decimals',
        }),
        client.readContract({
          address: config.tokenAddress,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [safe],
        }),
        client.getBalance({ address: safe }),
      ]);
      return {
        ownerAddress: owner,
        safeAddress: safe,
        deployed,
        tokenAddress: config.tokenAddress,
        decimals,
        tokenBalance: formatUnits(balance, decimals),
        ethBalance: formatUnits(eth, 18),
      };
    });
  }
  async function prepareTransfer(
    input: { recipient: Address; amount: string },
    signal?: AbortSignal,
  ): Promise<TransferPreview> {
    return network(async () => {
      assertActive(signal);
      if (await activity.readPending())
        throw new WalletError(
          'TRANSFER_PENDING',
          'Check the previous operation before sending another transfer.',
        );
      const info = await getAccount();
      const { units, data } = encodeTransfer(
        input.recipient,
        input.amount,
        info.decimals,
      );
      const recipient = getAddress(input.recipient);
      if (isAddressEqual(recipient, info.safeAddress))
        throw new WalletError(
          'INVALID_TRANSFER',
          'Choose a recipient different from your Safe.',
        );
      const balance = await client.readContract({
        address: config.tokenAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [info.safeAddress],
      });
      if (balance < units)
        throw new WalletError(
          'INSUFFICIENT_FUNDS',
          'Fund the Safe with enough test tokens first.',
        );
      const account = info.deployed
        ? new SafeAccountV0_3_0(info.safeAddress)
        : initializeSafe(info.ownerAddress);
      const transaction = { to: config.tokenAddress, value: 0n, data };
      const operation = await account.createUserOperation(
        [transaction],
        rpc,
        bundler,
        {
          expectedSigners: [info.ownerAddress],
        },
      );
      if (
        !isAddressEqual(getAddress(operation.sender), info.safeAddress) ||
        operation.callData !==
          SafeAccountV0_3_0.createAccountCallDataSingleTransaction(
            transaction,
          ) ||
        operation.paymaster !== null ||
        operation.paymasterData !== null ||
        operation.maxFeePerGas <= 0n ||
        operation.maxFeePerGas > 1_000_000_000_000n ||
        operation.maxPriorityFeePerGas < 0n ||
        operation.maxPriorityFeePerGas > operation.maxFeePerGas ||
        operation.callGasLimit <= 0n ||
        operation.verificationGasLimit <= 0n ||
        operation.preVerificationGas <= 0n
      )
        throw new WalletError(
          'INVALID_TRANSFER',
          'The constructed operation does not match the transfer.',
        );
      const maxGas = calculateUserOperationMaxGasCost(operation);
      const [eth, deposit, block] = await Promise.all([
        client.getBalance({ address: info.safeAddress }),
        client.readContract({
          address: SAFE_DEPLOYMENT.entryPoint,
          abi: entryPointAbi,
          functionName: 'balanceOf',
          args: [info.safeAddress],
        }),
        client.getBlock(),
      ]);
      if (eth + deposit < maxGas)
        throw new WalletError(
          'INSUFFICIENT_FUNDS',
          'Fund the Safe with Sepolia ETH to cover the maximum gas fee.',
        );
      assertActive(signal);
      const preview: TransferPreview = Object.freeze({
        ownerAddress: info.ownerAddress,
        safeAddress: info.safeAddress,
        tokenAddress: config.tokenAddress,
        recipient,
        amount: formatUnits(units, info.decimals),
        amountUnits: units.toString(),
        decimals: info.decimals,
        maxGasEth: formatUnits(maxGas, 18),
        deploysSafe: !info.deployed,
        expiresAt: Date.now() + 120_000,
      });
      prepared.set(preview, {
        operation: { ...operation },
        account,
        preparedAt: Date.now(),
        validUntil: block.timestamp + 600n,
      });
      return preview;
    });
  }
  async function submitTransfer(
    preview: TransferPreview,
    signal?: AbortSignal,
  ): Promise<SubmittedTransfer> {
    if (submitting)
      throw new WalletError(
        'TRANSFER_PENDING',
        'A transfer is already in progress.',
      );
    submitting = true;
    try {
      return await network(async () => {
        assertActive(signal);
        const record = prepared.get(preview);
        const assertFresh = () => {
          assertActive(signal);
          if (!record || Date.now() - record.preparedAt > 120_000)
            throw new WalletError(
              'TRANSFER_EXPIRED',
              'Prepare a fresh preview before signing.',
            );
        };
        assertFresh();
        if (!record)
          throw new WalletError(
            'TRANSFER_EXPIRED',
            'Prepare the transfer first.',
          );
        if (await activity.readPending())
          throw new WalletError(
            'TRANSFER_PENDING',
            'Check the previous operation first.',
          );
        await checkNetwork();
        await verifySafe(client, preview.safeAddress, preview.ownerAddress);
        const nonce = await client.readContract({
          address: SAFE_DEPLOYMENT.entryPoint,
          abi: entryPointAbi,
          functionName: 'getNonce',
          args: [preview.safeAddress, 0n],
        });
        if (nonce !== record.operation.nonce)
          throw new WalletError(
            'TRANSFER_EXPIRED',
            'The Safe nonce changed. Prepare a fresh preview.',
          );
        if (!isAddressEqual(await ownerAddress(), preview.ownerAddress))
          throw new WalletError('KEY_UNAVAILABLE', 'The owner changed.');
        assertFresh();
        let key;
        let signature: string;
        try {
          key = await storage.readPrivateKeyForSigning();
          assertFresh();
          if (
            !isAddressEqual(privateKeyToAddress(key), preview.ownerAddress) ||
            !isAddressEqual(await ownerAddress(), preview.ownerAddress)
          )
            throw new WalletError(
              'KEY_UNAVAILABLE',
              'The signing key does not match the owner.',
            );
          assertFresh();
          signature = record.account.signUserOperation(
            record.operation,
            [key],
            BigInt(SAFE_DEPLOYMENT.chainId),
            { validUntil: record.validUntil },
          );
        } catch (e) {
          if (e instanceof WalletError) throw e;
          throw new WalletError(
            'SIGNING_FAILED',
            'Safe operation signing failed.',
          );
        } finally {
          key = undefined;
        }
        assertFresh();
        prepared.delete(preview);
        const operation = { ...record.operation, signature };
        const submitted: SubmittedTransfer = {
          ownerAddress: preview.ownerAddress,
          safeAddress: preview.safeAddress,
          tokenAddress: preview.tokenAddress,
          recipient: preview.recipient,
          amountUnits: preview.amountUnits,
          decimals: preview.decimals,
          nonce: operation.nonce.toString(),
          validUntil: record.validUntil.toString(),
          userOperationHash: createUserOperationHash(
            operation,
            SAFE_DEPLOYMENT.entryPoint,
            BigInt(SAFE_DEPLOYMENT.chainId),
          ) as Hash,
        };
        // Store the expected hash before the request: a timeout does not prove
        // rejection, and blindly retrying can send a second transfer.
        await activity.writePending(submitted);
        if (signal?.aborted) {
          await activity.writePending(null);
          assertActive(signal);
        }
        const returnedHash = await bundler.sendUserOperation(
          operation,
          SAFE_DEPLOYMENT.entryPoint,
        );
        if (
          returnedHash.toLowerCase() !==
          submitted.userOperationHash.toLowerCase()
        )
          throw new WalletError(
            'VERIFICATION_FAILED',
            'Bundler returned an unexpected operation hash. Check pending status.',
          );
        return submitted;
      });
    } finally {
      submitting = false;
    }
  }
  async function confirmTransfer(
    submitted: SubmittedTransfer,
  ): Promise<ConfirmedTransfer | null> {
    return network(async () => {
      await checkNetwork();
      const owner = await ownerAddress();
      if (
        !isAddressEqual(submitted.ownerAddress, owner) ||
        !isAddressEqual(submitted.safeAddress, predictSafeAddress(owner)) ||
        !isAddressEqual(submitted.tokenAddress, config.tokenAddress)
      )
        throw new WalletError(
          'VERIFICATION_FAILED',
          'Tracking data does not belong to this wallet.',
        );
      const inclusion = await bundler.getUserOperationReceipt(
        submitted.userOperationHash,
      );
      if (!inclusion) {
        // Only release ambiguous tracking once the signed validity window is
        // over on-chain AND the nonce is demonstrably unused. No blind retry.
        const block = await client.getBlock();
        if (block.timestamp > BigInt(submitted.validUntil) + 60n) {
          const nonce = await client.readContract({
            address: SAFE_DEPLOYMENT.entryPoint,
            abi: entryPointAbi,
            functionName: 'getNonce',
            args: [submitted.safeAddress, 0n],
            blockNumber: block.number,
          });
          if (nonce === BigInt(submitted.nonce)) {
            await activity.writePending(null);
            throw new WalletError(
              'TRANSFER_EXPIRED',
              'The operation expired with an unused nonce. You can prepare a new transfer.',
            );
          }
        }
        return null;
      }
      const receipt = await client.getTransactionReceipt({
        hash: inclusion.receipt.transactionHash as Hash,
      });
      if (
        (await client.getBlockNumber({ cacheTime: 0 })) <
        receipt.blockNumber + 1n
      )
        return null;
      let start = 0;
      let end = -1;
      let successful = false;
      for (let i = 0; i < receipt.logs.length; i++) {
        const log = receipt.logs[i];
        if (!isAddressEqual(log.address, SAFE_DEPLOYMENT.entryPoint)) continue;
        try {
          const event = decodeEventLog({
            abi: entryPointAbi,
            data: log.data,
            topics: log.topics,
          });
          if (event.eventName !== 'UserOperationEvent') continue;
          if (
            event.args.userOpHash.toLowerCase() ===
              submitted.userOperationHash.toLowerCase() &&
            isAddressEqual(event.args.sender, submitted.safeAddress) &&
            event.args.nonce === BigInt(submitted.nonce)
          ) {
            end = i;
            successful = event.args.success;
            break;
          }
          start = i + 1;
        } catch {
          /* Other EntryPoint events. */
        }
      }
      if (end < 0)
        throw new WalletError(
          'VERIFICATION_FAILED',
          'The operation was not found in the on-chain receipt.',
        );
      if (receipt.status !== 'success' || !successful) {
        await activity.writePending(null);
        throw new WalletError(
          'TRANSFER_FAILED',
          'The operation reverted on Sepolia. No successful transfer was confirmed.',
        );
      }
      const transferred = receipt.logs.slice(start, end).some((log) => {
        if (!isAddressEqual(log.address, submitted.tokenAddress)) return false;
        try {
          const event = decodeEventLog({
            abi: erc20Abi,
            data: log.data,
            topics: log.topics,
          });
          return (
            event.eventName === 'Transfer' &&
            isAddressEqual(event.args.from, submitted.safeAddress) &&
            isAddressEqual(event.args.to, submitted.recipient) &&
            event.args.value === BigInt(submitted.amountUnits)
          );
        } catch {
          return false;
        }
      });
      if (
        !transferred ||
        !(await verifySafe(
          client,
          submitted.safeAddress,
          owner,
          receipt.blockNumber,
        ))
      )
        throw new WalletError(
          'VERIFICATION_FAILED',
          'The expected token transfer or Safe configuration could not be verified.',
        );
      const balances = await Promise.all(
        [receipt.blockNumber - 1n, receipt.blockNumber].flatMap((blockNumber) =>
          [submitted.safeAddress, submitted.recipient].map((address) =>
            client.readContract({
              address: submitted.tokenAddress,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [address],
              blockNumber,
            }),
          ),
        ),
      );
      const [senderBefore, recipientBefore, senderAfter, recipientAfter] =
        balances;
      const amount = BigInt(submitted.amountUnits);
      const result: ConfirmedTransfer = {
        ...submitted,
        transactionHash: receipt.transactionHash,
        explorerUrl: `https://sepolia.etherscan.io/tx/${receipt.transactionHash}`,
        blockNumber: receipt.blockNumber.toString(),
        senderBalanceBefore: formatUnits(senderBefore, submitted.decimals),
        senderBalanceAfter: formatUnits(senderAfter, submitted.decimals),
        recipientBalanceBefore: formatUnits(
          recipientBefore,
          submitted.decimals,
        ),
        recipientBalanceAfter: formatUnits(recipientAfter, submitted.decimals),
        balanceChangesMatch:
          senderBefore - senderAfter === amount &&
          recipientAfter - recipientBefore === amount,
      };
      await activity.writeConfirmed(result);
      await activity.writePending(null);
      return result;
    });
  }
  return { getAccount, prepareTransfer, submitTransfer, confirmTransfer };
}
