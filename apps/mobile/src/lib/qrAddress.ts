import { getAddress, isAddress, type Address } from 'viem';

/**
 * Extracts the recipient address from a scanned QR code.
 *
 * Accepted formats:
 * - a plain address, as shown by the Receive screen (`0x…`)
 * - an EIP-681 URI: `ethereum:0x…`, `ethereum:pay-0x…@11155111`
 * - an ERC-20 EIP-681 transfer: `ethereum:<token>@<chainId>/transfer?address=<recipient>&uint256=<amount>`
 *   (the recipient is the `address` parameter; the amount is ignored)
 *
 * Returns the checksummed address, or null when no valid address is found.
 */
export function parseQrAddress(text: string): Address | null {
  const value = text.trim();
  if (!value) return null;
  if (!/^ethereum:/i.test(value)) return toAddress(value);

  const rest = value.slice('ethereum:'.length);
  const queryIndex = rest.indexOf('?');
  const path = queryIndex === -1 ? rest : rest.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : rest.slice(queryIndex + 1);

  // path = [pay-]<target>[@chainId][/function]
  const slashIndex = path.indexOf('/');
  const targetWithChain = slashIndex === -1 ? path : path.slice(0, slashIndex);
  const fn = slashIndex === -1 ? null : path.slice(slashIndex + 1);
  const target = targetWithChain.split('@')[0].replace(/^pay-/i, '');

  if (fn !== null) {
    if (fn.toLowerCase() !== 'transfer') return null;
    const recipient = readParam(query, 'address');
    return recipient === null ? null : toAddress(recipient);
  }
  return toAddress(target);
}

function readParam(query: string, name: string): string | null {
  for (const pair of query.split('&')) {
    const [key, raw = ''] = pair.split('=');
    if (key === name) {
      try {
        return decodeURIComponent(raw);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function toAddress(value: string): Address | null {
  // Non-strict: accept all-lowercase or all-uppercase hex, reject a bad mixed-case checksum.
  if (!isAddress(value)) return null;
  return getAddress(value);
}
