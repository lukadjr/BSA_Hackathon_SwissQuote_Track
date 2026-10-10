import { isAddress, isAddressEqual, parseUnits } from 'viem';
import {
  ApiError,
  getClientIdentity,
  getLinkStatus,
  registerWallet,
  request,
} from './api';
import type { ClientIdentity } from './api';
import { getSafeAccount } from './safeWallet';
import { getAddress, signMessage } from './wallet';
import { requireVerifiedIdentity } from './walletlink';

export interface TreasuryAccount {
  treasury_address: `0x${string}`;
  token_address: `0x${string}`;
  decimals: 6;
  balance_units: string;
  available_units: string;
  reserved_units: string;
  eth_balance_wei: string;
  chain_id: 11155111;
  token_label: string;
  bank_mocked: true;
  single_client_demo: true;
}
export interface FundingIntent {
  id: string;
  client_id: string;
  kind: 'deploy' | 'deposit';
  safe_address: `0x${string}`;
  owner_address: `0x${string}`;
  treasury_address: `0x${string}`;
  token_address: `0x${string}`;
  chain_id: 11155111;
  decimals: 6;
  amount_units: string;
  domain: string;
  security_mode:
    | 'setup_only'
    | 'unprotected_test_demo'
    | 'recovery_2_of_3_three_days'
    | 'recovery_2_of_3_demo_three_minutes';
  message: string;
  expires_at: string;
  status:
    | 'awaiting_confirmation'
    | 'queued'
    | 'submitted'
    | 'reconciling'
    | 'confirmed'
    | 'failed'
    | 'expired';
  transaction_hash: `0x${string}` | null;
  failure_reason: string | null;
  bank_mocked: true;
}
export const isActiveFunding = (i: FundingIntent) =>
  ['awaiting_confirmation', 'queued', 'submitted', 'reconciling'].includes(
    i.status,
  );
const same = (a: string, b: string) =>
  isAddress(a, { strict: false }) &&
  isAddress(b, { strict: false }) &&
  isAddressEqual(a as `0x${string}`, b as `0x${string}`);

export async function getTreasuryAccount(
  signal?: AbortSignal,
): Promise<TreasuryAccount> {
  const t = await request<TreasuryAccount>(
    '/bank/account',
    undefined,
    signal,
    'GET',
  );
  const token = process.env.EXPO_PUBLIC_ERC20_TEST_ADDRESS ?? '';
  if (
    !t ||
    t.chain_id !== 11155111 ||
    t.decimals !== 6 ||
    !t.bank_mocked ||
    !t.single_client_demo ||
    !isAddress(t.treasury_address, { strict: false }) ||
    !same(t.token_address, token) ||
    ![
      t.balance_units,
      t.available_units,
      t.reserved_units,
      t.eth_balance_wei,
    ].every((x) => typeof x === 'string' && /^\d+$/.test(x))
  ) {
    throw new ApiError(
      'SERVER',
      'The demo bank configuration does not match this app.',
    );
  }
  return t;
}

export function fundingAmountUnits(amount: string): string {
  if (!/^\d+(\.\d{1,6})?$/.test(amount) || amount.length > 20)
    throw new ApiError(
      'REJECTED',
      'Enter a positive amount with at most six decimal places.',
    );
  const units = parseUnits(amount, 6);
  if (units <= 0n || units > 10_000_000_000n)
    throw new ApiError(
      'REJECTED',
      'Use an amount greater than zero and at most 10,000 test tokens.',
    );
  return units.toString();
}

export function validateFundingIntent(
  i: FundingIntent,
  identity: ClientIdentity,
  safe: string,
  owner: string,
  treasury: TreasuryAccount,
  requireFresh = false,
) {
  if (!i) throw new ApiError('SERVER', 'Missing bank instruction.');
  const expiry = Date.parse(i.expires_at);
  const domain =
    process.env.EXPO_PUBLIC_WALLET_LINK_DOMAIN ?? 'swissquote-wallet.demo';
  if (
    !i ||
    i.client_id !== identity.client_id ||
    i.chain_id !== 11155111 ||
    i.decimals !== 6 ||
    i.bank_mocked !== true ||
    !same(i.safe_address, safe) ||
    !same(i.owner_address, owner) ||
    !same(i.token_address, treasury.token_address) ||
    !same(i.treasury_address, treasury.treasury_address) ||
    i.domain !== domain ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(i.id) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(i.expires_at) ||
    !Number.isFinite(expiry) ||
    !/^\d+$/.test(i.amount_units) ||
    !['deploy', 'deposit'].includes(i.kind) ||
    ![
      'setup_only',
      'unprotected_test_demo',
      'recovery_2_of_3_three_days',
      'recovery_2_of_3_demo_three_minutes',
    ].includes(i.security_mode) ||
    (i.kind === 'deploy'
      ? i.amount_units !== '0' || i.security_mode !== 'setup_only'
      : BigInt(i.amount_units) <= 0n ||
        BigInt(i.amount_units) > 10_000_000_000n ||
        i.security_mode === 'setup_only') ||
    ![
      'awaiting_confirmation',
      'queued',
      'submitted',
      'reconciling',
      'confirmed',
      'failed',
      'expired',
    ].includes(i.status) ||
    (i.transaction_hash !== null &&
      !/^0x[0-9a-fA-F]{64}$/.test(i.transaction_hash)) ||
    (i.status === 'confirmed' && i.kind === 'deposit' && !i.transaction_hash) ||
    (requireFresh &&
      (i.status !== 'awaiting_confirmation' ||
        expiry <= Date.now() ||
        expiry > Date.now() + 310_000))
  ) {
    throw new ApiError(
      'REJECTED',
      'This bank instruction expired or does not match your wallet.',
    );
  }
  const expected = [
    'Swissquote Wallet: authorize this demo bank operation.',
    `Domain: ${domain}`,
    `Purpose: bank-${i.kind}`,
    `Account: ${identity.client_id}`,
    `Safe: ${safe.toLowerCase()}`,
    `Owner key: ${owner.toLowerCase()}`,
    `Treasury: ${treasury.treasury_address.toLowerCase()}`,
    'Chain ID: 11155111',
    `Token: ${treasury.token_address.toLowerCase()}`,
    `Amount (base units): ${i.amount_units}`,
    `Security: ${i.security_mode}`,
    `Nonce: ${i.id}`,
    `Expires: ${i.expires_at}`,
    'Testnet only. Bank identity and compliance checks are simulated.',
  ].join('\n');
  if (i.message !== expected)
    throw new ApiError(
      'SERVER',
      'Unexpected bank instruction. Refresh and review again.',
    );
}

export function listFunding(signal?: AbortSignal) {
  return request<{ intents: FundingIntent[] }>(
    '/bank/funding/intents',
    undefined,
    signal,
    'GET',
  );
}
export function getFunding(id: string, signal?: AbortSignal) {
  return request<FundingIntent>(
    `/bank/funding/intents/${encodeURIComponent(id)}`,
    undefined,
    signal,
    'GET',
  );
}
export async function prepareFunding(
  kind: FundingIntent['kind'],
  amount: string,
  idempotencyKey: string,
  signal?: AbortSignal,
) {
  const identity = await getClientIdentity(signal);
  requireVerifiedIdentity(identity);
  const safe = await getSafeAccount();
  const treasury = await getTreasuryAccount(signal);
  if (kind === 'deploy') {
    if (safe.deployed)
      throw new ApiError(
        'REJECTED',
        'Your Safe is already deployed. Link it to the demo bank.',
      );
    await registerWallet(
      identity.client_id,
      safe.safeAddress,
      safe.ownerAddress,
      signal,
    );
  } else {
    const link = await getLinkStatus(signal);
    if (
      !safe.deployed ||
      !link.bank_transfers_allowed ||
      !same(link.safe_address ?? '', safe.safeAddress) ||
      !same(link.owner_address ?? '', safe.ownerAddress) ||
      link.client_id !== identity.client_id ||
      link.chain_id !== 11155111
    )
      throw new ApiError(
        'REJECTED',
        'Deploy your Safe and verify its bank link before adding money.',
      );
  }
  const units = kind === 'deploy' ? '0' : fundingAmountUnits(amount);
  if (BigInt(units) > BigInt(treasury.available_units))
    throw new ApiError('REJECTED', 'Not enough test tokens in the demo bank.');
  const result = await request<FundingIntent>(
    '/bank/funding/intents',
    {
      kind,
      safe_address: safe.safeAddress,
      owner_address: safe.ownerAddress,
      chain_id: 11155111,
      amount: kind === 'deploy' ? '0' : amount,
      idempotency_key: idempotencyKey,
    },
    signal,
  );
  validateFundingIntent(
    result,
    identity,
    safe.safeAddress,
    safe.ownerAddress,
    treasury,
  );
  if (result.kind !== kind || result.amount_units !== units)
    throw new ApiError(
      'SERVER',
      'The bank returned a different operation or amount.',
    );
  return result;
}

export async function confirmFunding(
  intent: FundingIntent,
  signal?: AbortSignal,
) {
  const identity = await getClientIdentity(signal);
  requireVerifiedIdentity(identity);
  const safe = await getSafeAccount();
  const owner = await getAddress();
  const treasury = await getTreasuryAccount(signal);
  if (!owner || !same(owner, safe.ownerAddress))
    throw new ApiError('REJECTED', 'Wallet owner changed.');
  validateFundingIntent(
    intent,
    identity,
    safe.safeAddress,
    owner,
    treasury,
    true,
  );
  const signed = await signMessage(intent.message, { signal });
  if (
    signal?.aborted ||
    !same(signed.address, owner) ||
    Date.parse(intent.expires_at) <= Date.now()
  )
    throw new ApiError(
      'REJECTED',
      'Signing cancelled or funding instruction expired.',
    );
  const result = await request<FundingIntent>(
    `/bank/funding/intents/${encodeURIComponent(intent.id)}/confirm`,
    { signature: signed.signature },
    signal,
  );
  validateFundingIntent(result, identity, safe.safeAddress, owner, treasury);
  if (result.id !== intent.id || result.message !== intent.message)
    throw new ApiError(
      'SERVER',
      'Unexpected funding confirmation. Check the original request status.',
    );
  return result;
}

export function describeFundingError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 503)
      return 'Bank funding is unavailable. Check the treasury, worker, network and recovery configuration.';
    if (error.status === 403)
      return 'Verified bank identity, wallet control and required security setup are needed.';
    if (error.status === 409)
      return 'Another request is active, the wallet changed, or treasury funds are insufficient. Refresh status.';
    return error.message;
  }
  return 'Could not complete this step. Check the connection and refresh the existing request.';
}
