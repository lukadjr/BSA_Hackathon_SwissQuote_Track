import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createUserOperationHash,
  SafeAccountV0_3_0,
  type UserOperationV7,
} from 'abstractionkit';
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  parseAbi,
  recoverAddress,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import {
  createSafeWallet,
  predictSafeAddress,
  SAFE_DEPLOYMENT,
  type OwnerKeyStorage,
  type SubmittedTransfer,
  type ConfirmedTransfer,
  type TransferActivityStore,
} from '../../packages/wallet-core';
import { safeAbi } from '../../packages/wallet-core/safe/account';
import {
  encodeTransfer,
  erc20Abi,
} from '../../packages/wallet-core/transactions/erc20';

// Public test vectors, used only with the mocked chain.
const key = `0x${'0'.repeat(63)}1` as const;
const owner = privateKeyToAddress(key);
const safe = predictSafeAddress(owner);
const token = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
const txHash = `0x${'3'.repeat(64)}`;
const blockHash = `0x${'4'.repeat(64)}`;
const eventAbi = parseAbi([
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
]);
let chainId: string;
let deployed: boolean;
let tokenBalance: bigint;
let ethBalance: bigint;
let nonce: bigint;
let threshold: bigint;
let success: boolean;
let includeTransfer: boolean;
let inclusion: boolean;
let pending: SubmittedTransfer | null;
let confirmed: ConfirmedTransfer | null;
let sent: UserOperationV7 | null;
let sendTimeout: boolean;
let receiptStatus: string;
let nextBlock: bigint;
let trace: string[];
const storage: OwnerKeyStorage = {
  readAddress: vi.fn(async () => owner),
  readPrivateKeyForSigning: vi.fn(async () => key),
  saveNewWallet: vi.fn(),
};
const activity: TransferActivityStore = {
  readPending: async () => pending,
  writePending: async (value) => {
    trace.push('persist');
    pending = value;
  },
  writeConfirmed: async (value) => {
    confirmed = value;
  },
};
const wallet = () =>
  createSafeWallet({
    config: {
      rpcUrl: 'https://rpc.test',
      bundlerUrl: 'https://bundler.test',
      tokenAddress: token,
    },
    storage,
    activity,
  });
const hex = (n: bigint) => `0x${n.toString(16)}`;
const result = (
  abi: typeof erc20Abi | typeof safeAbi,
  functionName: string,
  value: unknown,
) =>
  encodeFunctionResult({ abi, functionName, result: value } as Parameters<
    typeof encodeFunctionResult
  >[0]);

function logs() {
  if (!pending) throw new Error('No pending op');
  const base = {
    blockNumber: '0x64',
    blockHash,
    transactionHash: txHash,
    transactionIndex: '0x0',
    removed: false,
  };
  const transfer = {
    ...base,
    address: token,
    logIndex: '0x0',
    topics: encodeEventTopics({
      abi: erc20Abi,
      eventName: 'Transfer',
      args: { from: safe, to: recipient },
    }),
    data: encodeAbiParameters([{ type: 'uint256' }], [1_000_000n]),
  };
  const operation = {
    ...base,
    address: SAFE_DEPLOYMENT.entryPoint,
    logIndex: '0x1',
    topics: encodeEventTopics({
      abi: eventAbi,
      eventName: 'UserOperationEvent',
      args: {
        userOpHash: pending.userOperationHash,
        sender: safe,
        paymaster: '0x0000000000000000000000000000000000000000',
      },
    }),
    data: encodeAbiParameters(
      [
        { type: 'uint256' },
        { type: 'bool' },
        { type: 'uint256' },
        { type: 'uint256' },
      ],
      [0n, success, 1n, 1n],
    ),
  };
  return includeTransfer ? [transfer, operation] : [operation];
}
function receipt() {
  return {
    transactionHash: txHash,
    transactionIndex: '0x0',
    blockNumber: '0x64',
    blockHash,
    from: recipient,
    to: SAFE_DEPLOYMENT.entryPoint,
    cumulativeGasUsed: '0x1',
    gasUsed: '0x1',
    effectiveGasPrice: '0x1',
    logs: logs(),
    logsBloom: `0x${'0'.repeat(512)}`,
    status: receiptStatus,
    type: '0x2',
  };
}
async function rpc(method: string, params: unknown[] = []) {
  switch (method) {
    case 'eth_chainId':
      return chainId;
    case 'eth_supportedEntryPoints':
      return [SAFE_DEPLOYMENT.entryPoint];
    case 'eth_getCode':
      return String(params[0]).toLowerCase() === safe.toLowerCase() && !deployed
        ? '0x'
        : '0x6000';
    case 'eth_getBalance':
      return hex(ethBalance);
    case 'eth_gasPrice':
      return '0x3b9aca00';
    case 'eth_maxPriorityFeePerGas':
      return '0x3b9aca00';
    case 'eth_getBlockByNumber':
      return {
        number: '0x63',
        timestamp: hex(BigInt(Math.floor(Date.now() / 1000))),
        hash: blockHash,
        transactions: [],
      };
    case 'eth_blockNumber':
      return hex(nextBlock);
    case 'eth_getStorageAt': {
      const value =
        params[1] === '0x0'
          ? SAFE_DEPLOYMENT.singleton
          : SAFE_DEPLOYMENT.module;
      return `0x${'0'.repeat(24)}${value.slice(2)}`;
    }
    case 'eth_call': {
      const { to, data } = params[0] as { to: string; data: string };
      const selector = data.slice(0, 10);
      if (selector === '0x35567e1a')
        return encodeAbiParameters([{ type: 'uint256' }], [nonce]); // EntryPoint.getNonce
      if (to.toLowerCase() === token.toLowerCase()) {
        if (selector === '0x313ce567') return result(erc20Abi, 'decimals', 6);
        const isSafe =
          data.slice(-40).toLowerCase() === safe.slice(2).toLowerCase();
        const after = params[1] === '0x64';
        return result(
          erc20Abi,
          'balanceOf',
          isSafe
            ? after
              ? 9_000_000n
              : tokenBalance
            : after
              ? 1_000_000n
              : 0n,
        );
      }
      if (to.toLowerCase() === SAFE_DEPLOYMENT.entryPoint.toLowerCase())
        return encodeAbiParameters([{ type: 'uint256' }], [0n]);
      if (selector === '0xa0e67e2b')
        return result(safeAbi, 'getOwners', [owner]);
      if (selector === '0xe75235b8')
        return result(safeAbi, 'getThreshold', threshold);
      if (selector === '0xffa1ad74') return result(safeAbi, 'VERSION', '1.4.1');
      if (selector === '0xcc2f8452')
        return result(safeAbi, 'getModulesPaginated', [
          [SAFE_DEPLOYMENT.module],
          '0x0000000000000000000000000000000000000001',
        ]);
      throw new Error(`Unexpected call ${selector}`);
    }
    case 'eth_estimateUserOperationGas':
      return {
        callGasLimit: '0x186a0',
        verificationGasLimit: '0x493e0',
        preVerificationGas: '0xc350',
      };
    case 'eth_sendUserOperation': {
      trace.push('send');
      const raw = params[0] as Record<string, unknown>;
      sent = Object.fromEntries(
        Object.entries(raw).map(([k, v]) => [
          k,
          [
            'nonce',
            'callGasLimit',
            'verificationGasLimit',
            'preVerificationGas',
            'maxFeePerGas',
            'maxPriorityFeePerGas',
          ].includes(k)
            ? BigInt(v as string)
            : v,
        ]),
      ) as unknown as UserOperationV7;
      deployed = true;
      if (sendTimeout) throw new Error('secret URL and key must never surface');
      return createUserOperationHash(
        sent,
        SAFE_DEPLOYMENT.entryPoint,
        11155111n,
      );
    }
    case 'eth_getUserOperationReceipt':
      return inclusion
        ? {
            userOpHash: pending!.userOperationHash,
            entryPoint: SAFE_DEPLOYMENT.entryPoint,
            sender: safe,
            nonce: '0x0',
            paymaster: '0x0000000000000000000000000000000000000000',
            actualGasCost: '0x1',
            actualGasUsed: '0x1',
            success,
            logs: logs(),
            receipt: receipt(),
          }
        : null;
    case 'eth_getTransactionReceipt':
      return receipt();
    default:
      throw new Error(`Unhandled RPC ${method}`);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  chainId = '0xaa36a7';
  deployed = false;
  tokenBalance = 10_000_000n;
  ethBalance = 10n ** 18n;
  nonce = 0n;
  threshold = 1n;
  success = true;
  includeTransfer = true;
  inclusion = true;
  pending = null;
  confirmed = null;
  sent = null;
  sendTimeout = false;
  receiptStatus = '0x1';
  nextBlock = 101n;
  trace = [];
  vi.mocked(storage.readAddress).mockResolvedValue(owner);
  vi.mocked(storage.readPrivateKeyForSigning).mockResolvedValue(key);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: unknown, init: RequestInit) => {
      const request = JSON.parse(init.body as string) as {
        id: number;
        method: string;
        params: unknown[];
      };
      const value = await rpc(request.method, request.params);
      return new Response(
        JSON.stringify({ id: request.id, jsonrpc: '2.0', result: value }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('Sepolia Safe transfer', () => {
  it('builds, signs, deploys and independently verifies a token transfer', async () => {
    const service = wallet();
    const preview = await service.prepareTransfer({ recipient, amount: '1' });
    expect(preview.deploysSafe).toBe(true);
    expect(storage.readPrivateKeyForSigning).not.toHaveBeenCalled();
    const submission = await service.submitTransfer(preview);
    expect(trace).toEqual(['persist', 'send']);
    expect(sent!.factory).toBe(SAFE_DEPLOYMENT.factory);
    const signature = sent!.signature as Hex;
    const validUntil = BigInt(`0x${signature.slice(14, 26)}`);
    const hash = SafeAccountV0_3_0.getUserOperationEip712Hash(
      sent!,
      11155111n,
      { validUntil },
    );
    expect(
      await recoverAddress({
        hash: hash as Hex,
        signature: `0x${signature.slice(26)}`,
      }),
    ).toBe(owner);
    const proof = await service.confirmTransfer(submission);
    expect(proof).toMatchObject({
      transactionHash: txHash,
      balanceChangesMatch: true,
      senderBalanceAfter: '9',
      recipientBalanceAfter: '1',
    });
    expect(pending).toBeNull();
    expect(confirmed).toEqual(proof);
  });
  it('reuses a deployed Safe without factory data', async () => {
    deployed = true;
    const service = wallet();
    const preview = await service.prepareTransfer({ recipient, amount: '1' });
    expect(preview.deploysSafe).toBe(false);
    await service.submitTransfer(preview);
    expect(sent!.factory).toBeNull();
  });
  it('rejects the wrong chain and an unexpected Safe threshold before authentication', async () => {
    chainId = '0x1';
    await expect(wallet().getAccount()).rejects.toMatchObject({
      code: 'CHAIN_CONFIG_INVALID',
    });
    chainId = '0xaa36a7';
    deployed = true;
    threshold = 2n;
    await expect(wallet().getAccount()).rejects.toMatchObject({
      code: 'SAFE_CONFIG_INVALID',
    });
    expect(storage.readPrivateKeyForSigning).not.toHaveBeenCalled();
  });
  it('rejects insufficient tokens and gas before authentication', async () => {
    tokenBalance = 0n;
    await expect(
      wallet().prepareTransfer({ recipient, amount: '1' }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    tokenBalance = 10_000_000n;
    ethBalance = 0n;
    await expect(
      wallet().prepareTransfer({ recipient, amount: '1' }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    expect(storage.readPrivateKeyForSigning).not.toHaveBeenCalled();
  });
  it('cancels during authentication without persisting or broadcasting', async () => {
    const service = wallet();
    const controller = new AbortController();
    const preview = await service.prepareTransfer({ recipient, amount: '1' });
    vi.mocked(storage.readPrivateKeyForSigning).mockImplementationOnce(
      async () => {
        controller.abort();
        return key;
      },
    );
    await expect(
      service.submitTransfer(preview, controller.signal),
    ).rejects.toMatchObject({ code: 'AUTH_CANCELLED' });
    expect(sent).toBeNull();
    expect(pending).toBeNull();
  });
  it('rejects mismatched keys, stale nonces, expired previews and forged previews', async () => {
    const service = wallet();
    const preview = await service.prepareTransfer({ recipient, amount: '1' });
    vi.mocked(storage.readPrivateKeyForSigning).mockResolvedValueOnce(
      `0x${'0'.repeat(63)}2`,
    );
    await expect(service.submitTransfer(preview)).rejects.toMatchObject({
      code: 'KEY_UNAVAILABLE',
    });
    nonce = 1n;
    await expect(service.submitTransfer(preview)).rejects.toMatchObject({
      code: 'TRANSFER_EXPIRED',
    });
    await expect(
      service.submitTransfer({ ...preview, amount: '1000' }),
    ).rejects.toMatchObject({ code: 'TRANSFER_EXPIRED' });
    vi.spyOn(Date, 'now').mockReturnValue(preview.expiresAt + 1);
    await expect(service.submitTransfer(preview)).rejects.toMatchObject({
      code: 'TRANSFER_EXPIRED',
    });
    vi.restoreAllMocks();
    expect(sent).toBeNull();
  });
  it('keeps tracking after an ambiguous send failure and blocks duplicate sending', async () => {
    const service = wallet();
    const preview = await service.prepareTransfer({ recipient, amount: '1' });
    sendTimeout = true;
    await expect(service.submitTransfer(preview)).rejects.toMatchObject({
      code: 'NETWORK_FAILED',
      message: 'Sepolia request failed. Check connectivity and configuration.',
    });
    expect(pending).not.toBeNull();
    await expect(
      service.prepareTransfer({ recipient, amount: '1' }),
    ).rejects.toMatchObject({ code: 'TRANSFER_PENDING' });
    expect(await wallet().confirmTransfer(pending!)).toMatchObject({
      transactionHash: txHash,
    });
  });
  it('waits for inclusion and two confirmations', async () => {
    const service = wallet();
    const submission = await service.submitTransfer(
      await service.prepareTransfer({ recipient, amount: '1' }),
    );
    inclusion = false;
    expect(await service.confirmTransfer(submission)).toBeNull();
    inclusion = true;
    nextBlock = 100n;
    expect(await service.confirmTransfer(submission)).toBeNull();
    expect(pending).not.toBeNull();
  });
  it('releases an expired ambiguous operation only when its nonce is unused', async () => {
    const service = wallet();
    const submission = await service.submitTransfer(
      await service.prepareTransfer({ recipient, amount: '1' }),
    );
    inclusion = false;
    vi.spyOn(Date, 'now').mockReturnValue(
      (Number(submission.validUntil) + 120) * 1000,
    );
    try {
      nonce = 1n;
      expect(await service.confirmTransfer(submission)).toBeNull();
      expect(pending).not.toBeNull();
      nonce = 0n;
      await expect(service.confirmTransfer(submission)).rejects.toMatchObject({
        code: 'TRANSFER_EXPIRED',
      });
      expect(pending).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });
  it('does not mistake an EntryPoint transaction success for operation success', async () => {
    const service = wallet();
    const submission = await service.submitTransfer(
      await service.prepareTransfer({ recipient, amount: '1' }),
    );
    success = false;
    await expect(service.confirmTransfer(submission)).rejects.toMatchObject({
      code: 'TRANSFER_FAILED',
    });
    expect(confirmed).toBeNull();
    expect(pending).toBeNull();
  });
  it('requires the token Transfer event, not just a successful operation', async () => {
    const service = wallet();
    const submission = await service.submitTransfer(
      await service.prepareTransfer({ recipient, amount: '1' }),
    );
    includeTransfer = false;
    await expect(service.confirmTransfer(submission)).rejects.toMatchObject({
      code: 'VERIFICATION_FAILED',
    });
    expect(confirmed).toBeNull();
    expect(pending).not.toBeNull();
  });
  it.each(['1.0000001', '0', '-1', '1e6', 'NaN'])(
    'rejects unsafe token amount %s',
    (amount) => {
      expect(() => encodeTransfer(recipient, amount, 6)).toThrow();
    },
  );
  it('rejects a zero recipient and preserves exact token units', () => {
    expect(() =>
      encodeTransfer('0x0000000000000000000000000000000000000000', '1', 6),
    ).toThrow();
    expect(encodeTransfer(recipient, '1.000001', 6).units).toBe(1_000_001n);
  });
});
