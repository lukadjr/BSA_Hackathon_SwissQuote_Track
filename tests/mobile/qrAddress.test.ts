import { expect, it } from 'vitest';
import { parseQrAddress } from '../../apps/mobile/src/lib/qrAddress';

const recipient = '0x52908400098527886E0F7030069857D2E4169EE7';
const token = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';

it('accepts the plain address encoded by the Receive screen', () => {
  expect(parseQrAddress(recipient)).toBe(recipient);
  expect(parseQrAddress(`  ${recipient.toLowerCase()}\n`)).toBe(recipient);
});

it('accepts EIP-681 URIs with an optional chain id', () => {
  expect(parseQrAddress(`ethereum:${recipient}`)).toBe(recipient);
  expect(parseQrAddress(`ethereum:${recipient}@11155111`)).toBe(recipient);
  expect(parseQrAddress(`ethereum:pay-${recipient}@11155111?value=1`)).toBe(
    recipient,
  );
});

it('takes the recipient from an ERC-20 transfer URI', () => {
  expect(
    parseQrAddress(
      `ethereum:${token}@11155111/transfer?address=${recipient}&uint256=1e6`,
    ),
  ).toBe(recipient);
  expect(
    parseQrAddress(`ethereum:${token}/transfer?address=${recipient}`),
  ).toBe(recipient);
});

it('rejects anything that is not a valid address', () => {
  for (const text of [
    '',
    'hello',
    '0x1234',
    // Mixed case with a wrong checksum.
    '0x52908400098527886e0F7030069857D2E4169EE7',
    `ethereum:${token}@11155111/transfer?uint256=1`,
    `ethereum:${token}@11155111/approve?address=${recipient}`,
    `ethereum:${token}/transfer?address=0xnope`,
    'ethereum:not-an-address',
    '{"t":"sqw-guardian-accept"}',
  ])
    expect(parseQrAddress(text)).toBeNull();
});
