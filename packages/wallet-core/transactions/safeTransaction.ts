import {
  concatHex,
  decodeEventLog,
  encodeFunctionData,
  encodePacked,
  formatUnits,
  getAddress,
  hashTypedData,
  isAddressEqual,
  parseAbi,
  zeroAddress,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { WalletError } from '../errors';
import type { OwnerKeyStorage } from '../keys/storage';
import {
  SAFE_DEPLOYMENT,
  verifySafe,
  type SepoliaClient,
} from '../safe/account';
import {
  protectCalls,
  cancelRecoveryCall,
  invalidateApprovalsCall,
  replaceGuardianCalls,
  type Call,
} from '../recovery/module';
import { encodeTransfer, erc20Abi } from './erc20';
import type {
  SafeAccountInfo,
  SecurityState,
  SecurityAction,
  SecurityPreview,
  TransferPreview,
  SubmittedTransfer,
  ConfirmedTransfer,
  TransferActivityStore,
} from './userOperation';

export const MULTISEND_CALL_ONLY =
  '0x9641d764fc13c8B624c04430C7356C1C7C8102e2' as Address;
export const safeTransactionTypes = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;
export const safeRelayAbi = parseAbi([
  'function nonce() view returns(uint256)',
  'function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns(bytes32)',
  'event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)',
  'event ExecutionFailure(bytes32 indexed txHash,uint256 payment)',
]);
export interface SafeRelayTransaction {
  to: Address;
  value: '0';
  data: Hex;
  operation: 0 | 1;
  nonce: string;
}
export interface SafeRelayRequest {
  chain_id: 11155111;
  safe_address: Address;
  owner_address: Address;
  kind: 'transfer' | SecurityAction['kind'];
  transaction: SafeRelayTransaction;
  signature: Hex;
}
export interface RelayStatus {
  id: Hash;
  safe_address: Address;
  kind: string;
  status: 'queued' | 'submitted' | 'reconciling' | 'confirmed' | 'failed';
  transaction_hash: Hash | null;
  gas_payer: 'swissquote_treasury';
}
export interface TreasuryRelay {
  submit(request: SafeRelayRequest, signal?: AbortSignal): Promise<RelayStatus>;
  status(hash: Hash): Promise<RelayStatus | null>;
  readPending(): Promise<SafeRelayRequest | null>;
  writePending(request: SafeRelayRequest | null): Promise<void>;
}
export function safeTransactionTypedData(
  safe: Address,
  tx: SafeRelayTransaction,
) {
  return {
    domain: { chainId: SAFE_DEPLOYMENT.chainId, verifyingContract: safe },
    types: safeTransactionTypes,
    primaryType: 'SafeTx' as const,
    message: {
      to: tx.to,
      value: 0n,
      data: tx.data,
      operation: tx.operation,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: zeroAddress,
      refundReceiver: zeroAddress,
      nonce: BigInt(tx.nonce),
    },
  };
}
export function buildSafeRelayTransaction(
  calls: Call[],
  nonce: bigint,
): SafeRelayTransaction {
  if (!calls.length || calls.length > 4 || calls.some((c) => c.value !== 0n))
    throw new WalletError('INVALID_TRANSFER', 'Unsupported Safe calls.');
  if (calls.length === 1)
    return {
      to: calls[0].to,
      value: '0',
      data: calls[0].data,
      operation: 0,
      nonce: nonce.toString(),
    };
  const packed = concatHex(
    calls.map((c) =>
      encodePacked(
        ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
        [0, c.to, 0n, BigInt((c.data.length - 2) / 2), c.data],
      ),
    ),
  );
  return {
    to: MULTISEND_CALL_ONLY,
    value: '0',
    operation: 1,
    nonce: nonce.toString(),
    data: encodeFunctionData({
      abi: parseAbi(['function multiSend(bytes transactions)']),
      functionName: 'multiSend',
      args: [packed],
    }),
  };
}
function active(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new WalletError(
      'AUTH_CANCELLED',
      'Operation cancelled before submission.',
    );
}

/** Same product methods as ERC-4337; ordinary Safe nonce/signatures and treasury gas. */
export function createTreasuryOperations({
  client,
  storage,
  relay,
  activity,
  getAccount,
  getSecurityState,
}: {
  client: SepoliaClient;
  storage: OwnerKeyStorage;
  relay: TreasuryRelay;
  activity: TransferActivityStore;
  getAccount(): Promise<SafeAccountInfo>;
  getSecurityState(): Promise<SecurityState>;
}) {
  const prepared = new WeakMap<
    object,
    {
      tx: SafeRelayTransaction;
      safe: Address;
      owner: Address;
      kind: SafeRelayRequest['kind'];
      time: number;
    }
  >();
  let submitting = false;
  async function nonce(safe: Address) {
    return client.readContract({
      address: safe,
      abi: safeRelayAbi,
      functionName: 'nonce',
    });
  }
  async function assertIdle() {
    if (
      submitting ||
      (await relay.readPending()) ||
      (await activity.readPending())
    )
      throw new WalletError(
        'TRANSFER_PENDING',
        'Check the pending treasury operation before signing another.',
      );
  }
  async function build(
    safe: Address,
    owner: Address,
    kind: SafeRelayRequest['kind'],
    calls: Call[],
    preview: object,
  ) {
    const tx = buildSafeRelayTransaction(calls, await nonce(safe));
    const local = hashTypedData(safeTransactionTypedData(safe, tx));
    const onchain = await client.readContract({
      address: safe,
      abi: safeRelayAbi,
      functionName: 'getTransactionHash',
      args: [
        tx.to,
        0n,
        tx.data,
        tx.operation,
        0n,
        0n,
        0n,
        zeroAddress,
        zeroAddress,
        BigInt(tx.nonce),
      ],
    });
    if (local.toLowerCase() !== onchain.toLowerCase())
      throw new WalletError(
        'VERIFICATION_FAILED',
        'Safe transaction hash mismatch.',
      );
    prepared.set(preview, { tx, safe, owner, kind, time: Date.now() });
  }
  async function prepareTransfer(
    input: { recipient: Address; amount: string },
    signal?: AbortSignal,
  ): Promise<TransferPreview> {
    active(signal);
    await assertIdle();
    const info = await getAccount();
    if (!info.deployed)
      throw new WalletError(
        'SAFE_CONFIG_INVALID',
        'Deploy your wallet through Add money first.',
      );
    const recipient = getAddress(input.recipient);
    const { units, data } = encodeTransfer(
      recipient,
      input.amount,
      info.decimals,
    );
    if (
      isAddressEqual(recipient, info.safeAddress) ||
      units > 10_000n * 10n ** BigInt(info.decimals)
    )
      throw new WalletError(
        'INVALID_TRANSFER',
        'Transfer refused by demo policy.',
      );
    const balance = await client.readContract({
      address: info.tokenAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [info.safeAddress],
    });
    if (balance < units)
      throw new WalletError('INSUFFICIENT_FUNDS', 'Not enough test tokens.');
    const preview: TransferPreview = Object.freeze({
      ownerAddress: info.ownerAddress,
      safeAddress: info.safeAddress,
      tokenAddress: info.tokenAddress,
      recipient,
      amount: formatUnits(units, info.decimals),
      amountUnits: units.toString(),
      decimals: info.decimals,
      maxGasEth: '0',
      deploysSafe: false,
      expiresAt: Date.now() + 120_000,
      gasPayer: 'swissquote_treasury',
    });
    await build(
      info.safeAddress,
      info.ownerAddress,
      'transfer',
      [{ to: info.tokenAddress, value: 0n, data }],
      preview,
    );
    active(signal);
    return preview;
  }
  async function prepareSecurityOperation(
    action: SecurityAction,
    signal?: AbortSignal,
  ): Promise<SecurityPreview> {
    active(signal);
    await assertIdle();
    const state = await getSecurityState();
    if (!state.deployed)
      throw new WalletError(
        'SAFE_CONFIG_INVALID',
        'Deploy your wallet through Add money before protecting it.',
      );
    let calls: Call[], module: Address;
    if (action.kind === 'protect') {
      if (state.recovery)
        throw new WalletError(
          'SAFE_CONFIG_INVALID',
          'Recovery is already configured.',
        );
      module = getAddress(action.module);
      calls = protectCalls(
        state.safeAddress,
        state.ownerAddress,
        module,
        action.guardians,
      );
    } else {
      if (!state.recovery)
        throw new WalletError(
          'SAFE_CONFIG_INVALID',
          'Recovery is not configured.',
        );
      module = state.recovery.module;
      if (action.kind === 'cancel-recovery') {
        if (!state.recovery.pending)
          throw new WalletError('SAFE_CONFIG_INVALID', 'No pending recovery.');
        calls = [cancelRecoveryCall(module)];
      } else {
        if (state.recovery.pending)
          throw new WalletError(
            'SAFE_CONFIG_INVALID',
            'Cancel recovery before changing security.',
          );
        calls =
          action.kind === 'invalidate-approvals'
            ? [invalidateApprovalsCall(module)]
            : replaceGuardianCalls(
                module,
                state.recovery.guardians,
                action.oldGuardian,
                action.newGuardian,
                state.ownerAddress,
              );
      }
    }
    const preview: SecurityPreview = Object.freeze({
      kind: action.kind,
      ownerAddress: state.ownerAddress,
      safeAddress: state.safeAddress,
      module,
      maxGasEth: '0',
      deploysSafe: false,
      expiresAt: Date.now() + 120_000,
      gasPayer: 'swissquote_treasury',
    });
    await build(
      state.safeAddress,
      state.ownerAddress,
      action.kind,
      calls,
      preview,
    );
    active(signal);
    return preview;
  }
  async function submit(
    preview: object,
    signal?: AbortSignal,
    transfer?: TransferPreview,
  ) {
    active(signal);
    if (submitting)
      throw new WalletError(
        'TRANSFER_PENDING',
        'An operation is already being submitted.',
      );
    submitting = true;
    try {
      if ((await relay.readPending()) || (await activity.readPending()))
        throw new WalletError(
          'TRANSFER_PENDING',
          'Check the pending operation first.',
        );
      const record = prepared.get(preview);
      const fresh = () => {
        active(signal);
        if (!record || Date.now() - record.time > 120_000)
          throw new WalletError(
            'TRANSFER_EXPIRED',
            'Prepare a fresh confirmation.',
          );
      };
      fresh();
      if (!record)
        throw new WalletError(
          'TRANSFER_EXPIRED',
          'Prepare the operation first.',
        );
      await verifySafe(client, record.safe, record.owner);
      if ((await nonce(record.safe)) !== BigInt(record.tx.nonce))
        throw new WalletError('TRANSFER_EXPIRED', 'Safe nonce changed.');
      const address = await storage.readAddress();
      if (!address || !isAddressEqual(address, record.owner))
        throw new WalletError('KEY_UNAVAILABLE', 'Owner changed.');
      fresh();
      let key;
      let signature: Hex;
      try {
        key = await storage.readPrivateKeyForSigning();
        fresh();
        const account = privateKeyToAccount(key);
        const current = await storage.readAddress();
        if (
          !isAddressEqual(account.address, record.owner) ||
          !current ||
          !isAddressEqual(current, record.owner)
        )
          throw new WalletError('KEY_UNAVAILABLE', 'Owner key changed.');
        // Recheck after biometric authentication; signatures are bound to the Safe nonce.
        await verifySafe(client, record.safe, record.owner);
        if ((await nonce(record.safe)) !== BigInt(record.tx.nonce))
          throw new WalletError('TRANSFER_EXPIRED', 'Safe nonce changed.');
        fresh();
        signature = await account.signTypedData(
          safeTransactionTypedData(record.safe, record.tx),
        );
      } finally {
        key = undefined;
      }
      fresh();
      prepared.delete(preview);
      const request: SafeRelayRequest = {
        chain_id: 11155111,
        safe_address: record.safe,
        owner_address: record.owner,
        kind: record.kind,
        transaction: record.tx,
        signature,
      };
      const hash = hashTypedData(
        safeTransactionTypedData(record.safe, record.tx),
      );
      // Persist signed PUBLIC authorization before network; restart can resend identical bytes.
      let submitted: SubmittedTransfer | undefined;
      if (transfer) {
        submitted = {
          ownerAddress: record.owner,
          safeAddress: record.safe,
          tokenAddress: transfer.tokenAddress,
          recipient: transfer.recipient,
          amountUnits: transfer.amountUnits,
          decimals: transfer.decimals,
          nonce: record.tx.nonce,
          validUntil: '0',
          userOperationHash: hash,
          execution: 'treasury',
        };
        await activity.writePending(submitted);
      }
      // Transfer tracking precedes signed authorization, so storage failure
      // cannot leave a transferable authorization invisible to the Send screen.
      try {
        await relay.writePending(request);
      } catch (error) {
        await relay.writePending(null);
        if (submitted) await activity.writePending(null);
        throw error;
      }
      // Nothing reached the relay yet: backgrounding during local storage can
      // discard this local authorization without leaving an invisible pending job.
      if (signal?.aborted) {
        await activity.writePending(null);
        await relay.writePending(null);
        active(signal);
      }
      const returned = await relay.submit(request, signal);
      if (
        returned.id.toLowerCase() !== hash.toLowerCase() ||
        returned.safe_address.toLowerCase() !== record.safe.toLowerCase()
      )
        throw new WalletError(
          'VERIFICATION_FAILED',
          'Relay returned an unexpected operation.',
        );
      return { hash, submitted };
    } finally {
      submitting = false;
    }
  }
  async function submitTransfer(
    preview: TransferPreview,
    signal?: AbortSignal,
  ): Promise<SubmittedTransfer> {
    const { submitted } = await submit(preview, signal, preview);
    return submitted!;
  }
  async function submitSecurityOperation(
    preview: SecurityPreview,
    signal?: AbortSignal,
  ) {
    return { userOperationHash: (await submit(preview, signal)).hash };
  }
  async function inclusion(hash: Hash, safe: Address) {
    let status = await relay.status(hash);
    if (!status) {
      const pending = await relay.readPending();
      if (
        pending &&
        hashTypedData(
          safeTransactionTypedData(pending.safe_address, pending.transaction),
        ).toLowerCase() === hash.toLowerCase()
      )
        status = await relay.submit(pending); // identical authorization after an ambiguous timeout
      else return null;
    }
    if (
      status.id.toLowerCase() !== hash.toLowerCase() ||
      !isAddressEqual(status.safe_address, safe) ||
      status.gas_payer !== 'swissquote_treasury'
    )
      throw new WalletError('VERIFICATION_FAILED', 'Unexpected relay status.');
    if (status.status === 'failed' && !status.transaction_hash) {
      await relay.writePending(null);
      await activity.writePending(null);
      throw new WalletError(
        'TRANSFER_FAILED',
        'Treasury refused this operation; no transaction was signed.',
      );
    }
    if (
      !status.transaction_hash ||
      !['confirmed', 'failed'].includes(status.status)
    )
      return null;
    const receipt = await client.getTransactionReceipt({
      hash: status.transaction_hash,
    });
    const canonical = await client.getBlock({
      blockNumber: receipt.blockNumber,
    });
    if (canonical.hash !== receipt.blockHash) return null;
    if (
      (await client.getBlockNumber({ cacheTime: 0 })) <
      receipt.blockNumber + 1n
    )
      return null;
    if (receipt.status !== 'success') return { receipt, success: false };
    const events = receipt.logs
      .filter((log) => isAddressEqual(log.address, safe))
      .flatMap((log) => {
        try {
          const event = decodeEventLog({
            abi: safeRelayAbi,
            data: log.data,
            topics: log.topics,
          });
          return event.args.txHash.toLowerCase() === hash.toLowerCase()
            ? [event]
            : [];
        } catch {
          return [];
        }
      });
    if (events.length !== 1 || events[0].args.payment !== 0n)
      throw new WalletError(
        'VERIFICATION_FAILED',
        'Safe execution event or fee reimbursement mismatch.',
      );
    return { receipt, success: events[0].eventName === 'ExecutionSuccess' };
  }
  async function checkSecurityOperation(hash: Hash) {
    const pending = await relay.readPending();
    if (!pending)
      throw new WalletError(
        'TRANSFER_PENDING',
        'No security tracking is available.',
      );
    if (
      pending.kind === 'transfer' ||
      hashTypedData(
        safeTransactionTypedData(pending.safe_address, pending.transaction),
      ).toLowerCase() !== hash.toLowerCase()
    )
      throw new WalletError(
        'VERIFICATION_FAILED',
        'Security tracking mismatch.',
      );
    const result = await inclusion(hash, pending.safe_address);
    if (!result) return null;
    await relay.writePending(null);
    return {
      transactionHash: result.receipt.transactionHash,
      success: result.success,
    };
  }
  async function resumePendingRelay() {
    const pending = await relay.readPending();
    if (!pending || pending.kind === 'transfer') return null;
    return checkSecurityOperation(
      hashTypedData(
        safeTransactionTypedData(pending.safe_address, pending.transaction),
      ),
    );
  }
  async function confirmTransfer(
    submitted: SubmittedTransfer,
  ): Promise<ConfirmedTransfer | null> {
    const info = await getAccount();
    if (
      submitted.execution !== 'treasury' ||
      !isAddressEqual(submitted.ownerAddress, info.ownerAddress) ||
      !isAddressEqual(submitted.safeAddress, info.safeAddress) ||
      !isAddressEqual(submitted.tokenAddress, info.tokenAddress)
    )
      throw new WalletError(
        'VERIFICATION_FAILED',
        'Transfer tracking does not match this wallet.',
      );
    const result = await inclusion(
      submitted.userOperationHash,
      submitted.safeAddress,
    );
    if (!result) return null;
    if (!result.success) {
      await relay.writePending(null);
      await activity.writePending(null);
      throw new WalletError('TRANSFER_FAILED', 'Safe transaction failed.');
    }
    const transfers = result.receipt.logs
      .filter((log) => isAddressEqual(log.address, submitted.tokenAddress))
      .flatMap((log) => {
        try {
          const event = decodeEventLog({
            abi: erc20Abi,
            data: log.data,
            topics: log.topics,
          });
          return event.eventName === 'Transfer' &&
            isAddressEqual(event.args.from, submitted.safeAddress) &&
            isAddressEqual(event.args.to, submitted.recipient) &&
            event.args.value === BigInt(submitted.amountUnits)
            ? [event]
            : [];
        } catch {
          return [];
        }
      });
    if (transfers.length !== 1)
      throw new WalletError(
        'VERIFICATION_FAILED',
        'Expected transfer event missing.',
      );
    const block = result.receipt.blockNumber;
    await verifySafe(
      client,
      submitted.safeAddress,
      submitted.ownerAddress,
      block,
    );
    const balances = await Promise.all(
      [block - 1n, block].flatMap((blockNumber) =>
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
    const [before, recipientBefore, after, recipientAfter] = balances;
    const confirmed: ConfirmedTransfer = {
      ...submitted,
      transactionHash: result.receipt.transactionHash,
      explorerUrl: `https://sepolia.etherscan.io/tx/${result.receipt.transactionHash}`,
      blockNumber: block.toString(),
      senderBalanceBefore: formatUnits(before, submitted.decimals),
      senderBalanceAfter: formatUnits(after, submitted.decimals),
      recipientBalanceBefore: formatUnits(recipientBefore, submitted.decimals),
      recipientBalanceAfter: formatUnits(recipientAfter, submitted.decimals),
      balanceChangesMatch:
        before - after === BigInt(submitted.amountUnits) &&
        recipientAfter - recipientBefore === BigInt(submitted.amountUnits),
    };
    await activity.writeConfirmed(confirmed);
    await activity.writePending(null);
    await relay.writePending(null);
    return confirmed;
  }
  return {
    prepareTransfer,
    submitTransfer,
    confirmTransfer,
    prepareSecurityOperation,
    submitSecurityOperation,
    checkSecurityOperation,
    resumePendingRelay,
  };
}
