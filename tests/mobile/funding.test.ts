vi.mock('../../apps/mobile/src/lib/auth', () => ({
  getSessionToken: async () => null,
}));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { parseUnits, verifyMessage } from 'viem';
const state = vi.hoisted(() => ({
  owner: '' as `0x${string}`,
  safe: `0x${'1'.repeat(40)}` as `0x${string}`,
  deployed: true,
  sign: vi.fn(),
}));
vi.mock('../../apps/mobile/src/lib/wallet', () => ({
  getAddress: async () => state.owner,
  signMessage: state.sign,
  describeWalletError: () => 'wallet error',
}));
vi.mock('../../apps/mobile/src/lib/safeWallet', () => ({
  getSafeAccount: async () => ({
    safeAddress: state.safe,
    ownerAddress: state.owner,
    deployed: state.deployed,
  }),
}));
import {
  confirmFunding,
  fundingAmountUnits,
  getTreasuryAccount,
  prepareFunding,
  validateFundingIntent,
  type FundingIntent,
  type TreasuryAccount,
} from '../../apps/mobile/src/lib/funding';
const token = `0x${'3'.repeat(40)}` as `0x${string}`;
const source = `0x${'4'.repeat(40)}` as `0x${string}`;
const identity = {
  client_id: 'alice',
  display_name: 'Alice',
  kyc_status: 'verified' as const,
  verified_at: null,
  mocked: true as const,
};
const treasury: TreasuryAccount = {
  treasury_address: source,
  token_address: token,
  decimals: 6,
  balance_units: '100000000',
  available_units: '100000000',
  reserved_units: '0',
  eth_balance_wei: '1000000000000000000',
  chain_id: 11155111,
  token_label: 'Test USDC',
  bank_mocked: true,
  single_client_demo: true,
};
let mutate: (i: FundingIntent) => void;
let linkAllowed: boolean;
let kyc: string;
let signingKey: `0x${string}`;
let last: FundingIntent;
const fetchMock = vi.fn<typeof fetch>();
function instruction(
  kind: 'deploy' | 'deposit' = 'deposit',
  units = '20000000',
): FundingIntent {
  const i: FundingIntent = {
    id: 'nonce_' + 'x'.repeat(24),
    client_id: 'alice',
    kind,
    safe_address: state.safe,
    owner_address: state.owner.toLowerCase() as `0x${string}`,
    treasury_address: source,
    token_address: token,
    chain_id: 11155111,
    decimals: 6,
    amount_units: kind === 'deploy' ? '0' : units,
    domain: 'swissquote-wallet.demo',
    security_mode:
      kind === 'deploy' ? 'setup_only' : 'recovery_2_of_3_three_days',
    message: '',
    expires_at: new Date(Date.now() + 300_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z'),
    status: 'awaiting_confirmation',
    transaction_hash: null,
    failure_reason: null,
    bank_mocked: true,
  };
  i.message = [
    'Swissquote Wallet: authorize this demo bank operation.',
    `Domain: ${i.domain}`,
    `Purpose: bank-${i.kind}`,
    'Account: alice',
    `Safe: ${state.safe}`,
    `Owner key: ${i.owner_address}`,
    `Treasury: ${source}`,
    'Chain ID: 11155111',
    `Token: ${token}`,
    `Amount (base units): ${i.amount_units}`,
    `Security: ${i.security_mode}`,
    `Nonce: ${i.id}`,
    `Expires: ${i.expires_at}`,
    'Testnet only. Bank identity and compliance checks are simulated.',
  ].join('\n');
  return i;
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}
beforeEach(() => {
  vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'http://demo-bank.test');
  vi.stubEnv('EXPO_PUBLIC_DEMO_ACCESS_TOKEN', 'demo-test-token');
  vi.stubEnv('EXPO_PUBLIC_ERC20_TEST_ADDRESS', token);
  vi.stubEnv('EXPO_PUBLIC_WALLET_LINK_DOMAIN', 'swissquote-wallet.demo');
  signingKey = generatePrivateKey();
  const account = privateKeyToAccount(signingKey);
  state.owner = account.address;
  state.deployed = true;
  state.sign
    .mockReset()
    .mockImplementation(
      async (message: string, options?: { signal?: AbortSignal }) => {
        if (options?.signal?.aborted) throw new Error('cancelled');
        return {
          address: account.address,
          signature: await account.signMessage({ message }),
        };
      },
    );
  mutate = () => {};
  linkAllowed = true;
  kyc = 'verified';
  fetchMock.mockReset().mockImplementation(async (url, init) => {
    if (init?.signal?.aborted) throw new Error('cancelled');
    const path = new URL(String(url)).pathname;
    if (path === '/auth/me') return json({ ...identity, kyc_status: kyc });
    if (path === '/bank/account') return json(treasury);
    if (path === '/wallets/link/status')
      return json({
        bank_transfers_allowed: linkAllowed,
        safe_address: state.safe,
        owner_address: state.owner,
        chain_id: 11155111,
        client_id: 'alice',
      });
    if (path === '/wallets/register') return json({ success: true });
    if (path === '/bank/funding/intents') {
      const body = JSON.parse(init!.body as string);
      last = instruction(body.kind, parseUnits(body.amount, 6).toString());
      mutate(last);
      return json(last);
    }
    if (path.endsWith('/confirm')) {
      const body = JSON.parse(init!.body as string);
      expect(
        await verifyMessage({
          address: state.owner,
          message: last.message,
          signature: body.signature,
        }),
      ).toBe(true);
      return json({ ...last, status: 'queued' });
    }
    throw new Error('unexpected endpoint');
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('funding amounts', () => {
  it.each([
    '0',
    '-1',
    'NaN',
    'Infinity',
    '1e2',
    '0.0000001',
    '10000.000001',
    '',
    ' 20',
    '20,5',
  ])('rejects %s', (value) => {
    expect(() => fundingAmountUnits(value)).toThrow();
  });
  it.each([
    ['20', '20000000'],
    ['0.000001', '1'],
    ['10000', '10000000000'],
  ])('converts %s exactly', (value, units) => {
    expect(fundingAmountUnits(value)).toBe(units);
  });
});
describe('bank funding consent', () => {
  it('reviews before signing and submits only a real local signature', async () => {
    const i = await prepareFunding(
      'deposit',
      '20.000001',
      'request_' + 'x'.repeat(24),
    );
    expect(i.amount_units).toBe('20000001');
    expect(state.sign).not.toHaveBeenCalled();
    const result = await confirmFunding(i);
    expect(result.status).toBe('queued');
    expect(state.sign).toHaveBeenCalledOnce();
    for (const [, init] of fetchMock.mock.calls)
      expect(String(init?.body ?? '')).not.toContain(signingKey);
  });
  it('allows setup before the Safe is deployed or linked', async () => {
    state.deployed = false;
    linkAllowed = false;
    const i = await prepareFunding('deploy', '', 'request_' + 'x'.repeat(24));
    expect(i.kind).toBe('deploy');
    expect(i.amount_units).toBe('0');
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith('/wallets/register'),
      ),
    ).toBe(true);
    await confirmFunding(i);
  });
  it.each(['pending', 'rejected'])(
    'rejects %s identity before signing',
    async (value) => {
      kyc = value;
      await expect(
        prepareFunding('deposit', '20', 'request_' + 'x'.repeat(24)),
      ).rejects.toThrow();
      expect(state.sign).not.toHaveBeenCalled();
    },
  );
  it('rejects an undeployed or unlinked receiving Safe', async () => {
    state.deployed = false;
    await expect(
      prepareFunding('deposit', '20', 'request_' + 'x'.repeat(24)),
    ).rejects.toThrow('Deploy');
    state.deployed = true;
    linkAllowed = false;
    await expect(
      prepareFunding('deposit', '20', 'request_' + 'x'.repeat(24)),
    ).rejects.toThrow('Deploy');
  });
  it.each([
    'client_id',
    'safe_address',
    'owner_address',
    'treasury_address',
    'token_address',
    'chain_id',
    'domain',
    'message',
    'amount_units',
  ])('rejects a changed %s', async (field) => {
    mutate = (i) => {
      (i as unknown as Record<string, unknown>)[field] =
        field === 'chain_id'
          ? 1
          : field.endsWith('address')
            ? `0x${'9'.repeat(40)}`
            : 'unexpected';
    };
    await expect(
      prepareFunding('deposit', '20', 'request_' + 'x'.repeat(24)),
    ).rejects.toThrow();
    expect(state.sign).not.toHaveBeenCalled();
  });
  it('rejects a canonical but different amount', async () => {
    mutate = (i) => Object.assign(i, instruction('deposit', '21000000'));
    await expect(
      prepareFunding('deposit', '20', 'request_' + 'x'.repeat(24)),
    ).rejects.toThrow('different');
  });
  it('rejects a canonical but different operation', async () => {
    mutate = (i) => Object.assign(i, instruction('deploy'));
    await expect(
      prepareFunding('deposit', '20', 'request_' + 'x'.repeat(24)),
    ).rejects.toThrow('different');
  });
  it('refuses expired consent before local authentication', async () => {
    const i = await prepareFunding(
      'deposit',
      '20',
      'request_' + 'x'.repeat(24),
    );
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 310_000);
    await expect(confirmFunding(i)).rejects.toThrow('expired');
    expect(state.sign).not.toHaveBeenCalled();
  });
  it('does not submit when native authentication is cancelled', async () => {
    const i = await prepareFunding(
      'deposit',
      '20',
      'request_' + 'x'.repeat(24),
    );
    state.sign.mockRejectedValueOnce(new Error('cancelled'));
    await expect(confirmFunding(i)).rejects.toThrow('cancelled');
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith('/confirm')),
    ).toBe(false);
  });
  it('does not submit after navigation aborts the signing attempt', async () => {
    const i = await prepareFunding(
      'deposit',
      '20',
      'request_' + 'x'.repeat(24),
    );
    const controller = new AbortController();
    const original = state.sign.getMockImplementation()!;
    state.sign.mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      controller.abort();
      return result;
    });
    await expect(confirmFunding(i, controller.signal)).rejects.toThrow(
      'cancelled',
    );
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith('/confirm')),
    ).toBe(false);
  });
  it('rejects owner changes before signing', async () => {
    const i = await prepareFunding(
      'deposit',
      '20',
      'request_' + 'x'.repeat(24),
    );
    state.owner = `0x${'9'.repeat(40)}`;
    await expect(confirmFunding(i)).rejects.toThrow();
    expect(state.sign).not.toHaveBeenCalled();
  });
  it('rejects a bank token configuration that differs from the app', async () => {
    vi.stubEnv('EXPO_PUBLIC_ERC20_TEST_ADDRESS', `0x${'9'.repeat(40)}`);
    await expect(getTreasuryAccount()).rejects.toThrow('configuration');
  });
  it('rejects success without a transaction hash for a deposit', () => {
    const i = { ...instruction(), status: 'confirmed' as const };
    expect(() =>
      validateFundingIntent(i, identity, state.safe, state.owner, treasury),
    ).toThrow();
  });
});
