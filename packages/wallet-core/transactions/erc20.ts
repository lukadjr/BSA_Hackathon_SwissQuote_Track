import {
  encodeFunctionData,
  isAddress,
  isAddressEqual,
  parseAbi,
  parseUnits,
  zeroAddress,
  type Address,
} from 'viem';
import { WalletError } from '../errors';

export const erc20Abi = parseAbi([
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

export function encodeTransfer(
  recipient: Address,
  amount: string,
  decimals: number,
) {
  if (
    !isAddress(recipient, { strict: false }) ||
    isAddressEqual(recipient, zeroAddress)
  )
    throw new WalletError(
      'INVALID_TRANSFER',
      'Enter a valid, nonzero recipient address.',
    );
  // viem parseUnits rounds excess precision: reject it explicitly before parsing.
  if (
    !/^\d+(?:\.\d+)?$/.test(amount) ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255 ||
    (amount.split('.')[1]?.length ?? 0) > decimals
  )
    throw new WalletError(
      'INVALID_TRANSFER',
      'Enter a positive amount within the token precision.',
    );
  const units = parseUnits(amount, decimals);
  if (units <= 0n || units >= 2n ** 256n)
    throw new WalletError(
      'INVALID_TRANSFER',
      'The token amount is out of range.',
    );
  return {
    units,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [recipient, units],
    }),
  };
}
