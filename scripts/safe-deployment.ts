// Public setup data only. Shares the app's pinned initializer and deterministic address.
import { SafeAccountV0_3_0 } from 'abstractionkit';
import { getAddress, type Address } from 'viem';
import {
  initializeSafe,
  SAFE_DEPLOYMENT,
} from '../packages/wallet-core/safe/account';

const owner = getAddress(process.argv[2]) as Address;
const account = initializeSafe(owner);
const [factory, data] = SafeAccountV0_3_0.createFactoryAddressAndData([owner], {
  threshold: 1,
  c2Nonce: 0n,
  safeAccountFactoryAddress: SAFE_DEPLOYMENT.factory,
  safe4337ModuleAddress: SAFE_DEPLOYMENT.module,
  safeModuleSetupAddress: SAFE_DEPLOYMENT.moduleSetup,
  entrypointAddress: SAFE_DEPLOYMENT.entryPoint,
});
process.stdout.write(
  JSON.stringify({
    safe_address: account.accountAddress.toLowerCase(),
    factory: factory.toLowerCase(),
    data,
  }),
);
