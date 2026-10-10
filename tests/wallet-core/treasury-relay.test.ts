import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  hashTypedData,
  parseAbi,
  recoverTypedDataAddress,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  buildSafeRelayTransaction,
  createTreasuryOperations,
  safeRelayAbi,
  safeTransactionTypedData,
  type SafeRelayRequest,
  type TreasuryRelay,
} from '../../packages/wallet-core/transactions/safeTransaction';
import { WalletError } from '../../packages/wallet-core/errors';
import type { SepoliaClient } from '../../packages/wallet-core/safe/account';
import type {
  SafeAccountInfo,
  SecurityState,
  SubmittedTransfer,
} from '../../packages/wallet-core/transactions/userOperation';

vi.mock('../../packages/wallet-core/safe/account', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../packages/wallet-core/safe/account')
    >();
  return { ...actual, verifySafe: vi.fn().mockResolvedValue(true) };
});
const key = ('0x' + '01'.repeat(32)) as Hex;
const owner = privateKeyToAccount(key);
const safe = getAddress('0x' + '11'.repeat(20));
const token = getAddress('0x' + '22'.repeat(20));
const recipient = getAddress('0x' + '33'.repeat(20));
const module = getAddress('0x38275826E1933303E508433dD5f289315Da2541c');
const transactionHash = ('0x' + '44'.repeat(32)) as Hash;

describe('treasury Safe transaction signing and tracking', () => {
  let pending: SafeRelayRequest | null;
  let tracked: SubmittedTransfer | null;
  let currentNonce: bigint;
  let receipt: unknown;
  let wallet: ReturnType<typeof createTreasuryOperations>;
  let relay: TreasuryRelay;
  let readKey: ReturnType<typeof vi.fn>;
  let status: ReturnType<typeof vi.fn>;
  let transferLog: unknown;
  let persistTransfer: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    pending = null;
    tracked = null;
    currentNonce = 0n;
    receipt = null;
    readKey = vi.fn().mockResolvedValue(key);
    status = vi.fn().mockResolvedValue(null);
    relay = {
      submit: vi.fn(async (request) => {
        const id = hashTypedData(
          safeTransactionTypedData(request.safe_address, request.transaction),
        );
        return {
          id,
          safe_address: safe,
          kind: request.kind,
          status: 'queued',
          transaction_hash: null,
          gas_payer: 'swissquote_treasury',
        };
      }),
      status,
      readPending: async () => pending,
      writePending: async (value) => {
        pending = value;
      },
    };
    const info: SafeAccountInfo = {
      ownerAddress: owner.address,
      safeAddress: safe,
      deployed: true,
      tokenAddress: token,
      decimals: 6,
      tokenBalance: '20',
      ethBalance: '0',
    };
    const security: SecurityState = {
      ownerAddress: owner.address,
      safeAddress: safe,
      deployed: true,
      recovery: {
        module,
        guardians: [recipient, token, getAddress('0x' + '55'.repeat(20))],
        threshold: 2,
        nonce: 0n,
        pending: { newOwners: [recipient], approvals: 2, executeAfter: 999 },
      },
    };
    const client = {
      readContract: vi.fn(
        async ({
          functionName,
          args,
          blockNumber,
        }: {
          functionName: string;
          args: unknown[];
          blockNumber?: bigint;
        }) => {
          if (functionName === 'nonce') return currentNonce;
          if (functionName === 'balanceOf')
            return blockNumber === undefined
              ? 20_000_000n
              : blockNumber === 9n
                ? args[0] === safe
                  ? 20_000_000n
                  : 0n
                : args[0] === safe
                  ? 19_000_000n
                  : 1_000_000n;
          if (functionName === 'getTransactionHash')
            return hashTypedData(
              safeTransactionTypedData(safe, {
                to: args[0] as Address,
                value: '0',
                data: args[2] as Hex,
                operation: args[3] as 0 | 1,
                nonce: (args[9] as bigint).toString(),
              }),
            );
          throw new Error(functionName);
        },
      ),
      getTransactionReceipt: async () => receipt,
      getBlockNumber: async () => 11n,
      getBlock: async () => ({ hash: '0xblock' }),
    } as unknown as SepoliaClient;
    transferLog = {
      address: token,
      topics: encodeEventTopics({
        abi: parseAbi([
          'event Transfer(address indexed from,address indexed to,uint256 value)',
        ]),
        eventName: 'Transfer',
        args: { from: safe, to: recipient },
      }),
      data: encodeAbiParameters([{ type: 'uint256' }], [1_000_000n]),
    };
    persistTransfer = vi.fn(async (value: SubmittedTransfer | null) => {
      tracked = value;
    });
    wallet = createTreasuryOperations({
      client,
      storage: {
        readAddress: async () => owner.address,
        readPrivateKeyForSigning: readKey,
      } as never,
      relay,
      activity: {
        readPending: async () => tracked,
        writePending: persistTransfer,
        writeConfirmed: vi.fn(),
      },
      getAccount: async () => info,
      getSecurityState: async () => security,
    });
  });
  it('signs standard Safe typed data after authentication and persists before submitting', async () => {
    const preview = await wallet.prepareTransfer({ recipient, amount: '1' });
    expect(preview.gasPayer).toBe('swissquote_treasury');
    expect(preview.maxGasEth).toBe('0');
    expect(readKey).not.toHaveBeenCalled();
    vi.mocked(relay.submit).mockImplementationOnce(async (request) => {
      expect(pending).toEqual(request);
      expect(tracked?.execution).toBe('treasury');
      expect(
        await recoverTypedDataAddress({
          ...safeTransactionTypedData(safe, request.transaction),
          signature: request.signature,
        }),
      ).toBe(owner.address);
      return {
        id: hashTypedData(safeTransactionTypedData(safe, request.transaction)),
        safe_address: safe,
        kind: 'transfer',
        status: 'queued',
        transaction_hash: null,
        gas_payer: 'swissquote_treasury',
      };
    });
    const sent = await wallet.submitTransfer(preview);
    expect(readKey).toHaveBeenCalledTimes(1);
    expect(sent.validUntil).toBe('0');
    expect(pending?.transaction.nonce).toBe('0');
  });
  it('reports an empty or malformed recipient as an invalid transfer', async () => {
    for (const bad of ['', '0x123', 'not-an-address'])
      await expect(
        wallet.prepareTransfer({ recipient: bad as Address, amount: '1' }),
      ).rejects.toMatchObject({ code: 'INVALID_TRANSFER' });
  });
  it('rejects a cloned or changed preview without reading the key', async () => {
    const preview = await wallet.prepareTransfer({ recipient, amount: '1' });
    await expect(
      wallet.submitTransfer({ ...preview, amount: '2' }),
    ).rejects.toMatchObject({ code: 'TRANSFER_EXPIRED' });
    expect(readKey).not.toHaveBeenCalled();
  });
  it('rejects changed Safe nonce before authentication', async () => {
    const preview = await wallet.prepareTransfer({ recipient, amount: '1' });
    currentNonce = 1n;
    await expect(wallet.submitTransfer(preview)).rejects.toMatchObject({
      code: 'TRANSFER_EXPIRED',
    });
    expect(readKey).not.toHaveBeenCalled();
  });
  it('aborts before signing or submitting after biometrics is cancelled', async () => {
    const preview = await wallet.prepareTransfer({ recipient, amount: '1' });
    readKey.mockRejectedValueOnce(
      new WalletError('AUTH_CANCELLED', 'Cancelled'),
    );
    await expect(wallet.submitTransfer(preview)).rejects.toMatchObject({
      code: 'AUTH_CANCELLED',
    });
    expect(relay.submit).not.toHaveBeenCalled();
    expect(pending).toBeNull();
  });
  it('rechecks activity after authentication', async () => {
    const signal = new AbortController();
    const preview = await wallet.prepareTransfer({ recipient, amount: '1' });
    readKey.mockImplementationOnce(async () => {
      signal.abort();
      return key;
    });
    await expect(
      wallet.submitTransfer(preview, signal.signal),
    ).rejects.toMatchObject({ code: 'AUTH_CANCELLED' });
    expect(relay.submit).not.toHaveBeenCalled();
  });
  it('retains the same signed authorization after a timeout and retries it without another biometric read', async () => {
    const preview = await wallet.prepareTransfer({ recipient, amount: '1' });
    vi.mocked(relay.submit).mockRejectedValueOnce(new Error('timeout'));
    await expect(wallet.submitTransfer(preview)).rejects.toThrow('timeout');
    const original = pending;
    expect(original).not.toBeNull();
    expect(await wallet.confirmTransfer(tracked!)).toBeNull();
    expect(relay.submit).toHaveBeenLastCalledWith(original);
    expect(readKey).toHaveBeenCalledTimes(1);
  });
  it('requires a matching indexed execution event, zero reimbursement and exact transfer event', async () => {
    const sent = await wallet.submitTransfer(
      await wallet.prepareTransfer({ recipient, amount: '1' }),
    );
    status.mockResolvedValue({
      id: sent.userOperationHash,
      safe_address: safe,
      kind: 'transfer',
      status: 'confirmed',
      transaction_hash: transactionHash,
      gas_payer: 'swissquote_treasury',
    });
    const log = {
      address: safe,
      topics: encodeEventTopics({
        abi: safeRelayAbi,
        eventName: 'ExecutionSuccess',
        args: { txHash: sent.userOperationHash },
      }),
      data: encodeAbiParameters([{ type: 'uint256' }], [0n]),
    };
    receipt = {
      transactionHash,
      blockNumber: 10n,
      blockHash: '0xblock',
      status: 'success',
      logs: [transferLog, log],
    };
    const confirmed = await wallet.confirmTransfer(sent);
    expect(confirmed?.balanceChangesMatch).toBe(true);
    expect(pending).toBeNull();
  });
  it('does not accept outer receipt success without matching Safe execution', async () => {
    const sent = await wallet.submitTransfer(
      await wallet.prepareTransfer({ recipient, amount: '1' }),
    );
    status.mockResolvedValue({
      id: sent.userOperationHash,
      safe_address: safe,
      kind: 'transfer',
      status: 'confirmed',
      transaction_hash: transactionHash,
      gas_payer: 'swissquote_treasury',
    });
    receipt = {
      transactionHash,
      blockNumber: 10n,
      blockHash: '0xblock',
      status: 'success',
      logs: [transferLog],
    };
    await expect(wallet.confirmTransfer(sent)).rejects.toMatchObject({
      code: 'VERIFICATION_FAILED',
    });
    expect(pending).not.toBeNull();
  });
  it('resumes a security operation after restart without signing again', async () => {
    const preview = await wallet.prepareSecurityOperation({
      kind: 'cancel-recovery',
    });
    const sent = await wallet.submitSecurityOperation(preview);
    status.mockResolvedValue({
      id: sent.userOperationHash,
      safe_address: safe,
      kind: 'cancel-recovery',
      status: 'confirmed',
      transaction_hash: transactionHash,
      gas_payer: 'swissquote_treasury',
    });
    receipt = {
      transactionHash,
      blockNumber: 10n,
      blockHash: '0xblock',
      status: 'success',
      logs: [
        {
          address: safe,
          topics: encodeEventTopics({
            abi: safeRelayAbi,
            eventName: 'ExecutionSuccess',
            args: { txHash: sent.userOperationHash },
          }),
          data: encodeAbiParameters([{ type: 'uint256' }], [0n]),
        },
      ],
    };
    expect(await wallet.resumePendingRelay()).toEqual({
      transactionHash,
      success: true,
    });
    expect(readKey).toHaveBeenCalledTimes(1);
  });
  it('clears local tracking when backgrounding interrupts storage before submission', async () => {
    const controller = new AbortController();
    const preview = await wallet.prepareTransfer({ recipient, amount: '1' });
    persistTransfer.mockImplementationOnce(async (value) => {
      tracked = value;
      controller.abort();
    });
    await expect(
      wallet.submitTransfer(preview, controller.signal),
    ).rejects.toMatchObject({ code: 'AUTH_CANCELLED' });
    expect(relay.submit).not.toHaveBeenCalled();
    expect(pending).toBeNull();
    expect(tracked).toBeNull();
  });
  it('does not persist a signed authorization if transfer tracking cannot be saved', async () => {
    const preview = await wallet.prepareTransfer({ recipient, amount: '1' });
    persistTransfer.mockRejectedValueOnce(
      new WalletError('STORAGE_FAILED', 'storage'),
    );
    await expect(wallet.submitTransfer(preview)).rejects.toMatchObject({
      code: 'STORAGE_FAILED',
    });
    expect(relay.submit).not.toHaveBeenCalled();
    expect(pending).toBeNull();
  });
  it('rolls back transfer tracking when signed authorization storage fails', async () => {
    const preview = await wallet.prepareTransfer({ recipient, amount: '1' });
    const original = relay.writePending;
    relay.writePending = vi
      .fn()
      .mockRejectedValueOnce(new WalletError('STORAGE_FAILED', 'storage'))
      .mockImplementation(original);
    await expect(wallet.submitTransfer(preview)).rejects.toMatchObject({
      code: 'STORAGE_FAILED',
    });
    expect(relay.submit).not.toHaveBeenCalled();
    expect(tracked).toBeNull();
    expect(pending).toBeNull();
  });
  it('rejects a nonce changed while the biometric prompt was open', async () => {
    const preview = await wallet.prepareTransfer({ recipient, amount: '1' });
    readKey.mockImplementationOnce(async () => {
      currentNonce = 1n;
      return key;
    });
    await expect(wallet.submitTransfer(preview)).rejects.toMatchObject({
      code: 'TRANSFER_EXPIRED',
    });
    expect(relay.submit).not.toHaveBeenCalled();
    expect(pending).toBeNull();
  });
  it('rejects Safe fee reimbursement even when the relay labels it confirmed', async () => {
    const sent = await wallet.submitTransfer(
      await wallet.prepareTransfer({ recipient, amount: '1' }),
    );
    status.mockResolvedValue({
      id: sent.userOperationHash,
      safe_address: safe,
      kind: 'transfer',
      status: 'confirmed',
      transaction_hash: transactionHash,
      gas_payer: 'swissquote_treasury',
    });
    receipt = {
      transactionHash,
      blockNumber: 10n,
      blockHash: '0xblock',
      status: 'success',
      logs: [
        transferLog,
        {
          address: safe,
          topics: encodeEventTopics({
            abi: safeRelayAbi,
            eventName: 'ExecutionSuccess',
            args: { txHash: sent.userOperationHash },
          }),
          data: encodeAbiParameters([{ type: 'uint256' }], [1n]),
        },
      ],
    };
    await expect(wallet.confirmTransfer(sent)).rejects.toMatchObject({
      code: 'VERIFICATION_FAILED',
    });
    expect(pending).not.toBeNull();
  });
  it('blocks a second operation while a signed relay is pending', async () => {
    await wallet.submitSecurityOperation(
      await wallet.prepareSecurityOperation({ kind: 'cancel-recovery' }),
    );
    await expect(
      wallet.prepareTransfer({ recipient, amount: '1' }),
    ).rejects.toMatchObject({ code: 'TRANSFER_PENDING' });
  });
});
it('encodes only zero-value CALLs inside the pinned batch', () => {
  const calls = [
    { to: safe, value: 0n, data: '0x12345678' as Hex },
    { to: token, value: 0n, data: '0xabcdef00' as Hex },
  ];
  const tx = buildSafeRelayTransaction(calls, 7n);
  expect(tx.operation).toBe(1);
  expect(tx.nonce).toBe('7');
  expect(tx.value).toBe('0');
  expect(() =>
    buildSafeRelayTransaction([{ ...calls[0], value: 1n }], 0n),
  ).toThrow();
});
