// Minimal ERC-4337 bundler for a LOCAL Sepolia fork only. It lets the real
// wallet-core code (estimate, sign, send, receipt) run against a fork, where
// no public bundler exists. Never point it at a live network.
import { createServer, type Server } from 'node:http';
import { createUserOperationHash } from 'abstractionkit';
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  pad,
  parseAbi,
  toHex,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { SAFE_DEPLOYMENT } from '../../packages/wallet-core';

const entryPointAbi = parseAbi([
  'struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }',
  'function handleOps(PackedUserOperation[] ops, address beneficiary)',
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
]);

type RpcOp = Record<string, string | null>;
const big = (v: string | null | undefined) => BigInt(v ?? 0);
const u128 = (v: bigint) => pad(toHex(v), { size: 16 });

export async function startForkBundler(input: {
  rpcUrl: string;
  /** Funded fork key that pays for handleOps. */
  executorKey: Hex;
  port?: number;
}): Promise<{ url: string; server: Server }> {
  const client = createPublicClient({
    chain: sepolia,
    transport: http(input.rpcUrl),
  });
  const executor = createWalletClient({
    account: privateKeyToAccount(input.executorKey),
    chain: sepolia,
    transport: http(input.rpcUrl),
  });
  const sent = new Map<string, Hash>();

  async function handle(method: string, params: unknown[]): Promise<unknown> {
    switch (method) {
      case 'eth_chainId':
        return toHex(SAFE_DEPLOYMENT.chainId);
      case 'eth_supportedEntryPoints':
        return [SAFE_DEPLOYMENT.entryPoint];
      case 'eth_estimateUserOperationGas':
        return {
          preVerificationGas: toHex(100_000n),
          verificationGasLimit: toHex(1_500_000n),
          callGasLimit: toHex(1_500_000n),
        };
      case 'eth_sendUserOperation': {
        const op = params[0] as RpcOp;
        const initCode =
          op.factory && op.factory !== '0x'
            ? concatHex([op.factory as Hex, (op.factoryData ?? '0x') as Hex])
            : '0x';
        const packed = {
          sender: op.sender as Address,
          nonce: big(op.nonce),
          initCode: initCode as Hex,
          callData: op.callData as Hex,
          accountGasLimits: concatHex([
            u128(big(op.verificationGasLimit)),
            u128(big(op.callGasLimit)),
          ]),
          preVerificationGas: big(op.preVerificationGas),
          gasFees: concatHex([
            u128(big(op.maxPriorityFeePerGas)),
            u128(big(op.maxFeePerGas)),
          ]),
          paymasterAndData: '0x' as Hex,
          signature: op.signature as Hex,
        };
        const userOpHash = createUserOperationHash(
          {
            ...op,
            nonce: big(op.nonce),
            callGasLimit: big(op.callGasLimit),
            verificationGasLimit: big(op.verificationGasLimit),
            preVerificationGas: big(op.preVerificationGas),
            maxFeePerGas: big(op.maxFeePerGas),
            maxPriorityFeePerGas: big(op.maxPriorityFeePerGas),
            paymasterVerificationGasLimit: null,
            paymasterPostOpGasLimit: null,
          } as never,
          SAFE_DEPLOYMENT.entryPoint,
          BigInt(SAFE_DEPLOYMENT.chainId),
        );
        const tx = await executor.writeContract({
          address: SAFE_DEPLOYMENT.entryPoint,
          abi: entryPointAbi,
          functionName: 'handleOps',
          args: [[packed], executor.account.address],
          gas: 6_000_000n,
        });
        await client.waitForTransactionReceipt({ hash: tx });
        sent.set(userOpHash.toLowerCase(), tx);
        return userOpHash;
      }
      case 'eth_getUserOperationReceipt': {
        const hash = String(params[0]).toLowerCase();
        const tx = sent.get(hash);
        if (!tx) return null;
        const receipt = await client.getTransactionReceipt({ hash: tx });
        for (const log of receipt.logs) {
          try {
            const event = decodeEventLog({
              abi: entryPointAbi,
              data: log.data,
              topics: log.topics,
            });
            if (
              event.eventName === 'UserOperationEvent' &&
              event.args.userOpHash.toLowerCase() === hash
            )
              return {
                userOpHash: hash,
                entryPoint: SAFE_DEPLOYMENT.entryPoint,
                sender: event.args.sender,
                nonce: toHex(event.args.nonce),
                paymaster: event.args.paymaster,
                actualGasCost: toHex(event.args.actualGasCost),
                actualGasUsed: toHex(event.args.actualGasUsed),
                success: event.args.success,
                logs: [],
                // Raw JSON-RPC receipt: the SDK converts its hex fields itself.
                receipt: await client.request({
                  method: 'eth_getTransactionReceipt',
                  params: [tx],
                }),
              };
          } catch {
            /* other logs */
          }
        }
        return null;
      }
      default:
        throw new Error(`fork bundler: unsupported ${method}`);
    }
  }

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      const call = JSON.parse(body) as {
        id: number;
        method: string;
        params: unknown[];
      };
      try {
        const result = await handle(call.method, call.params ?? []);
        res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
      } catch (e) {
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: call.id,
            error: {
              code: -32000,
              message: (e as Error).message.slice(0, 500),
            },
          }),
        );
      }
    });
  });
  const port = input.port ?? 8546;
  await new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${port}`, server };
}
