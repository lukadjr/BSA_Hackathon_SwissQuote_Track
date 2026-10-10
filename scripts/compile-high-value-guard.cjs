// Optional contract acceptance uses isolated test tools, never production dependencies.
const fs = require('node:fs');
const path = require('node:path');
const solc = require(
  path.join(
    process.env.FUNDING_EVM_TOOLS_DIR ||
      '/tmp/swissquote-funding-evm/node_modules',
    'solc',
  ),
);
const output = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: 'Solidity',
      sources: {
        'HighValueGuard.sol': {
          content: fs.readFileSync('contracts/src/HighValueGuard.sol', 'utf8'),
        },
      },
      settings: {
        evmVersion: 'shanghai',
        viaIR: true,
        optimizer: { enabled: true, runs: 200 },
        outputSelection: { '*': { '*': ['abi', 'evm.bytecode'] } },
      },
    }),
  ),
);
const errors = (output.errors || []).filter((e) => e.severity === 'error');
if (errors.length) {
  console.error(errors.map((e) => e.formattedMessage).join('\n'));
  process.exit(1);
}
process.stdout.write(
  JSON.stringify(output.contracts['HighValueGuard.sol'].HighValueGuard),
);
