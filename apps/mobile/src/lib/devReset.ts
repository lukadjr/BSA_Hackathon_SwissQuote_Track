// Development builds only: wipes this phone's wallet to replay onboarding.
import { WalletError } from '@swissquote/wallet-core';
import { resetWallet } from './walletSession';

export async function resetWalletForDev(): Promise<void> {
  if (!__DEV__) throw new WalletError('NOT_IMPLEMENTED', 'Development only.');
  await resetWallet();
}
