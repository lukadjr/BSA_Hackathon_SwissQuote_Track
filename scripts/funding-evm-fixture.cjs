// Optional integration fixture: Ganache + OpenZeppelin ERC20 + real Sepolia Safe code.
// Run with temporary tools installed as documented in backend/README.md.
const fs = require('node:fs');
const path = require('node:path');
const toolsDir =
  process.env.FUNDING_EVM_TOOLS_DIR ||
  '/tmp/swissquote-funding-evm/node_modules';
const ganache = require(path.join(toolsDir, 'ganache'));
const solc = require(path.join(toolsDir, 'solc'));
const {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseEther,
} = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const fixture =
  process.env.FUNDING_EVM_FIXTURE || '/tmp/swissquote-funding-evm/fixture.json';

async function main() {
  const server = ganache.server({
    chain: { chainId: 11155111 },
    wallet: { totalAccounts: 3 },
    logging: { quiet: true },
  });
  await server.listen(18545, '127.0.0.1');
  const url = 'http://127.0.0.1:18545';
  const accounts = Object.entries(server.provider.getInitialAccounts());
  const treasury = privateKeyToAccount(accounts[0][1].secretKey);
  const owner = privateKeyToAccount(accounts[1][1].secretKey);
  const client = createPublicClient({ transport: http(url) });
  const wallet = createWalletClient({
    account: treasury,
    transport: http(url),
  });
  const source =
    'pragma solidity ^0.8.20; import "@openzeppelin/contracts/token/ERC20/ERC20.sol"; contract TestUSDC is ERC20 { constructor() ERC20("Test USD Coin", "USDC") { _mint(msg.sender, 100 * 10**6); } function decimals() public pure override returns(uint8) { return 6; } }';
  const input = {
    language: 'Solidity',
    sources: { 'Test.sol': { content: source } },
    settings: {
      evmVersion: 'shanghai',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode'] } },
    },
  };
  const output = JSON.parse(
    solc.compile(JSON.stringify(input), {
      import: (name) => {
        try {
          return {
            contents: fs.readFileSync(path.join(toolsDir, name), 'utf8'),
          };
        } catch {
          return { error: `Missing ${name}` };
        }
      },
    }),
  );
  const contract = output.contracts?.['Test.sol']?.TestUSDC;
  if (!contract) throw new Error('Test contract compilation failed');
  const hash = await wallet.deployContract({
    abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}`,
    chain: null,
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  // Copy the pinned public deployments into the local EVM. No source-chain funds/keys.
  const addresses = [
    '0x29fcb43b46531bca003ddc8fcb67ffe91900c762',
    '0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67',
    '0x75cf11467937ce3f2f357ce24ffc3dbf8fd5c226',
    '0x2dd68b007b46fbe91b9a7c3eda5a7a1063cb5b47',
  ];
  const upstream =
    process.env.SEPOLIA_SOURCE_RPC ||
    'https://ethereum-sepolia-rpc.publicnode.com';
  for (const address of addresses) {
    const response = await fetch(upstream, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getCode',
        params: [address, 'latest'],
      }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!result.result || result.result === '0x')
      throw new Error('Safe source code unavailable');
    await server.provider.request({
      method: 'evm_setAccountCode',
      params: [address, result.result],
    });
  }
  fs.writeFileSync(
    fixture,
    JSON.stringify({
      rpc_url: url,
      token: receipt.contractAddress,
      treasury_key: treasury.key || accounts[0][1].secretKey,
      treasury_address: treasury.address,
      owner_key: accounts[1][1].secretKey,
      owner_address: owner.address,
    }),
    { mode: 0o600 },
  );
  fs.chmodSync(fixture, 0o600);
  console.log(
    `Local EVM fixture ready: ${fixture} (ephemeral test credentials; not printed)`,
  );
  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
main().catch(() => {
  console.error('Local EVM fixture failed; no secrets printed.');
  process.exit(1);
});
