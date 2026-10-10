// Development builds only: wipes this phone's wallet to replay onboarding.
import { clearWalletLinked } from './linkStatus';
import { deleteOwnerWalletForDev } from './secureStoreAdapter';

export async function resetWalletForDev(): Promise<void> {
  await clearWalletLinked();
  await deleteOwnerWalletForDev();
}
