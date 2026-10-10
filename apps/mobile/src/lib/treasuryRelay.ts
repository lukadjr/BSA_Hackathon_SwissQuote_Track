import type { Hash } from 'viem';
import { hashTypedData } from 'viem';
import {
  safeTransactionTypedData,
  WalletError,
  type TreasuryRelay,
  type SafeRelayRequest,
  type RelayStatus,
} from '@swissquote/wallet-core';
import * as SecureStore from 'expo-secure-store';
import { ApiError, request } from './api';

const KEY = 'swissquote.treasury.pending.v1';
const OPTIONS = {
  keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
};
export const treasuryRelay: TreasuryRelay = {
  submit: (payload, signal) =>
    request<RelayStatus>('/transactions/relay', payload, signal),
  async status(hash: Hash) {
    try {
      return await request<RelayStatus>(
        `/transactions/${hash}`,
        undefined,
        undefined,
        'GET',
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
  async readPending() {
    try {
      const json = await SecureStore.getItemAsync(KEY, OPTIONS);
      if (json === null) return null;
      const value = JSON.parse(json) as SafeRelayRequest;
      if (
        value.chain_id !== 11155111 ||
        !/^0x[\da-fA-F]{130}$/.test(value.signature) ||
        value.transaction.value !== '0' ||
        ![
          'transfer',
          'protect',
          'cancel-recovery',
          'invalidate-approvals',
          'replace-guardian',
        ].includes(value.kind)
      )
        throw new Error();
      hashTypedData(
        safeTransactionTypedData(value.safe_address, value.transaction),
      );
      return value;
    } catch {
      throw new WalletError(
        'STORAGE_FAILED',
        'Could not read treasury operation tracking.',
      );
    }
  },
  async writePending(value) {
    try {
      if (value === null) await SecureStore.deleteItemAsync(KEY, OPTIONS);
      else await SecureStore.setItemAsync(KEY, JSON.stringify(value), OPTIONS);
    } catch {
      throw new WalletError(
        'STORAGE_FAILED',
        'Could not save treasury operation tracking.',
      );
    }
  },
};
