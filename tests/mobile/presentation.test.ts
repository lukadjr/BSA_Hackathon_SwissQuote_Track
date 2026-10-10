import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 6,
}));
import { buildActivity } from '../../apps/mobile/src/lib/activity';
import {
  formatAmount,
  formatUsd,
  portfolioUsd,
} from '../../apps/mobile/src/lib/format';
import type { FundingIntent } from '../../apps/mobile/src/lib/funding';

const SAFE = '0x' + '1'.repeat(40);

function intent(over: Partial<FundingIntent>): FundingIntent {
  return {
    id: 'i1',
    client_id: 'demo-user',
    kind: 'deposit',
    safe_address: SAFE as `0x${string}`,
    owner_address: ('0x' + '2'.repeat(40)) as `0x${string}`,
    treasury_address: ('0x' + '3'.repeat(40)) as `0x${string}`,
    token_address: ('0x' + '4'.repeat(40)) as `0x${string}`,
    chain_id: 11155111,
    decimals: 6,
    amount_units: '12500000',
    domain: 'swissquote-wallet.demo',
    security_mode: 'recovery_2_of_3_demo_three_minutes',
    message: '',
    expires_at: '2026-10-10T10:05:00Z',
    created_at: '2026-10-10T10:00:00Z',
    status: 'confirmed',
    transaction_hash: ('0x' + 'a'.repeat(64)) as `0x${string}`,
    failure_reason: null,
    bank_mocked: true,
    ...over,
  };
}

describe('money formatting', () => {
  it('formats USD with grouping and two decimals', () => {
    expect(formatUsd(1234.5)).toBe('$1,234.50');
    expect(formatUsd('0')).toBe('$0.00');
    expect(formatUsd(null)).toBe('$—');
  });
  it('trims token amounts', () => {
    expect(formatAmount('1000.120000', 4)).toBe('1,000.12');
    expect(formatAmount('0.0000001', 5)).toBe('0');
  });
  it('values test USDC 1:1 and never counts Sepolia ETH', () => {
    expect(portfolioUsd({ usdc: '42.5' })).toBe(42.5);
    expect(portfolioUsd({ usdc: null })).toBeNull();
  });
});

describe('activity', () => {
  it('merges bank deposits for this Safe with sent transfers, newest first', () => {
    const items = buildActivity(
      [
        intent({}),
        intent({
          id: 'other',
          safe_address: ('0x' + '9'.repeat(40)) as `0x${string}`,
        }),
        intent({
          id: 'setup',
          kind: 'deploy',
          amount_units: '0',
          created_at: '2026-10-10T09:00:00Z',
        }),
        intent({ id: 'old', status: 'expired', transaction_hash: null }),
      ],
      [
        {
          hash: '0x' + 'b'.repeat(64),
          recipient: '0x' + '5'.repeat(40),
          amount: '3',
          at: '2026-10-10T11:00:00Z',
        },
      ],
      SAFE.toUpperCase().replace('0X', '0x'),
    );
    expect(items.map((i) => [i.id, i.kind, i.amount, i.status])).toEqual([
      ['0x' + 'b'.repeat(64), 'sent', '3', 'confirmed'],
      ['i1', 'deposit', '12.5', 'confirmed'],
      ['setup', 'setup', null, 'confirmed'],
    ]);
  });
});
