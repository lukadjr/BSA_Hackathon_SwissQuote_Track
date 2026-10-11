import { clearSession, getSession } from './auth';
import { clearActivityForDev } from './activity';
import { clearWalletLinked } from './linkStatus';
import {
  clearSafeTracking,
  currentSafeAddress,
  getSafeAccount,
  getSafeWallet,
} from './safeWallet';
import { disconnectOwnerWallet } from './secureStoreAdapter';
import { getRecoveryClient } from './recovery';
import { getAddress } from './wallet';
import { WalletError } from '@swissquote/wallet-core';
import { isAddressEqual } from 'viem';
import { clearGuardianStorage } from './guardianKey';
import { clearPausedOnboarding } from './onboardingNavigation';

/** User-requested full local reset, available in development and release builds. */
export async function resetWallet() {
  clearPausedOnboarding();
  let failed = false;
  // Close access first. Continue independent cleanup even if one store fails;
  // report partial resets so the user can retry instead of claiming success.
  for (const clear of [
    clearSession,
    disconnectOwnerWallet,
    clearWalletLinked,
    clearSafeTracking,
    clearActivityForDev,
    clearGuardianStorage,
  ]) {
    try {
      await clear();
    } catch {
      failed = true;
    }
  }
  if (failed)
    throw new WalletError(
      'STORAGE_FAILED',
      'Some phone data could not be deleted. Please retry Reset wallet.',
    );
}

/** Owner storage only: the independent guardian key and commitments survive. */
export async function logoutWallet() {
  clearPausedOnboarding();
  // Close access first; partial cleanup must never leave an authenticated wallet.
  await clearSession();
  await disconnectOwnerWallet();
  await clearWalletLinked();
  await clearSafeTracking();
  await clearActivityForDev();
}

export async function walletAccess(
  requireProtection = true,
  allowNewWallet = false,
): Promise<'signed-out' | 'active' | 'revoked' | 'setup-required'> {
  if (!(await getSession())) return 'signed-out';
  const owner = await getAddress();
  if (!owner) return allowNewWallet ? 'active' : 'signed-out';
  try {
    await getSafeAccount();
    if (
      requireProtection &&
      !(await getSafeWallet().getSecurityState()).recovery
    )
      return 'setup-required';
    return 'active';
  } catch (error) {
    if (!(error instanceof WalletError) || error.code !== 'SAFE_CONFIG_INVALID')
      throw error;
    // Configuration errors also cover other problems. Only a verified owner
    // rotation authorizes removing the old phone's key.
    const owners = await getRecoveryClient().readOwners(
      await currentSafeAddress(owner),
    );
    if (
      !owners.length ||
      owners.some((address) => isAddressEqual(address, owner))
    )
      throw error;
    await logoutWallet();
    return 'revoked';
  }
}
