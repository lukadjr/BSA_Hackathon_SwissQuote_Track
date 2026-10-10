import { describe, expect, it } from 'vitest';
import {
  decodeFunctionData,
  getAddress,
  hashTypedData,
  type Address,
} from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import {
  addressWords,
  backupAddressFromPhrase,
  createBackupPhrase,
  executeRecoveryCall,
  guardianInviteMessage,
  parseQrPayload,
  RECOVERY_MODULES,
  recoveryTypedData,
  signApprovalWithPhrase,
  signRecoveryApproval,
  verifyGuardianAcceptance,
  verifyRecoveryApproval,
} from '../../packages/wallet-core';
import {
  protectCalls,
  recoveryModuleAbi,
  replaceGuardianCalls,
} from '../../packages/wallet-core/recovery/module';

const module = RECOVERY_MODULES.threeDays;
const safe = getAddress('0x' + '1'.repeat(40));
const owner = getAddress('0x' + '2'.repeat(40));
const a = getAddress('0x' + 'a'.repeat(40));
const b = getAddress('0x' + 'b'.repeat(40));
const c = getAddress('0x' + 'c'.repeat(40));

describe('recovery module calls', () => {
  it('matches the EIP-712 hash returned by the deployed Sepolia module', () => {
    // getRecoveryHash(0x11…, [0x22…], 1, 5) read from 0x3827…541c on Sepolia.
    const hash = hashTypedData(
      recoveryTypedData({
        module,
        safe,
        newOwner: owner,
        nonce: 5n,
        chainId: 11155111,
      }),
    );
    expect(hash).toBe(
      '0x960f9289e6d9f6a5288c1aeca4fbeb5b07c7e4783fb1134c64e61d9f3b37a080',
    );
  });

  it('protects with enableModule then 3 guardians, threshold reaching 2 last', () => {
    const calls = protectCalls(safe, owner, module, {
      backup: a,
      swissquote: b,
      friend: c,
    });
    expect(calls[0].to).toBe(safe);
    const thresholds = calls.slice(1).map((call) => {
      const decoded = decodeFunctionData({
        abi: recoveryModuleAbi,
        data: call.data,
      });
      expect(decoded.functionName).toBe('addGuardianWithThreshold');
      return (decoded.args as [Address, bigint])[1];
    });
    expect(thresholds).toEqual([1n, 1n, 2n]);
  });

  it('refuses duplicate guardians, the owner as guardian and unknown modules', () => {
    expect(() =>
      protectCalls(safe, owner, module, {
        backup: a,
        swissquote: a,
        friend: c,
      }),
    ).toThrow();
    expect(() =>
      protectCalls(safe, owner, module, {
        backup: owner,
        swissquote: b,
        friend: c,
      }),
    ).toThrow();
    expect(() =>
      protectCalls(safe, owner, c, { backup: a, swissquote: b, friend: c }),
    ).toThrow();
  });

  it('replaces a guardian using the linked-list predecessor and keeps threshold 2', () => {
    const d = getAddress('0x' + 'd'.repeat(40));
    const [revoke, add] = replaceGuardianCalls(module, [a, b, c], b, d, owner);
    const args = (data: `0x${string}`) =>
      decodeFunctionData({ abi: recoveryModuleAbi, data }).args;
    expect(args(revoke.data)).toEqual([a, b, 2n]);
    expect(args(add.data)).toEqual([d, 2n]);
    const [revokeFirst] = replaceGuardianCalls(module, [a, b, c], a, d, owner);
    expect(args(revokeFirst.data)).toEqual([
      '0x0000000000000000000000000000000000000001',
      a,
      2n,
    ]);
    expect(() =>
      replaceGuardianCalls(module, [a, b, c], b, c, owner),
    ).toThrow();
    expect(() =>
      replaceGuardianCalls(module, [a, b, c], d, a, owner),
    ).toThrow();
  });

  it('sorts approvals by signer address as the module requires', () => {
    const call = executeRecoveryCall(module, safe, owner, [
      { guardian: c, signature: '0x01' },
      { guardian: a, signature: '0x02' },
    ]);
    const decoded = decodeFunctionData({
      abi: recoveryModuleAbi,
      data: call.data,
    });
    const sigs = (decoded.args as unknown[])[3] as { signer: Address }[];
    expect(sigs.map((s) => s.signer)).toEqual([a, c]);
    expect((decoded.args as unknown[])[4]).toBe(true);
  });
});

describe('guardian approvals', () => {
  const target = { safe, module, newOwner: owner, nonce: 3n };

  it('backup phrase: same address after re-typing with extra spaces/caps', async () => {
    const backup = createBackupPhrase();
    expect(backup.phrase.split(' ')).toHaveLength(12);
    const messy = `  ${backup.phrase.toUpperCase().replace(/ /g, '   ')} `;
    expect(backupAddressFromPhrase(messy)).toBe(backup.address);
    const approval = await signApprovalWithPhrase(messy, target);
    expect(approval.guardian).toBe(backup.address);
    expect(await verifyRecoveryApproval(target, approval)).toBe(true);
    expect(() =>
      backupAddressFromPhrase('not a valid phrase at all'),
    ).toThrow();
  });

  it('an approval is bound to the Safe, new owner and nonce', async () => {
    const key = generatePrivateKey();
    const approval = await signRecoveryApproval(key, target);
    expect(approval.guardian).toBe(privateKeyToAddress(key));
    expect(await verifyRecoveryApproval(target, approval)).toBe(true);
    expect(
      await verifyRecoveryApproval({ ...target, nonce: 4n }, approval),
    ).toBe(false);
    expect(
      await verifyRecoveryApproval({ ...target, newOwner: a }, approval),
    ).toBe(false);
    expect(
      await verifyRecoveryApproval(target, { ...approval, guardian: b }),
    ).toBe(false);
  });
});

describe('QR payloads and words', () => {
  it('derives stable 4-word codes that differ between addresses', () => {
    expect(addressWords(a)).toBe(addressWords(a.toLowerCase() as Address));
    expect(addressWords(a).split(' ')).toHaveLength(4);
    expect(addressWords(a)).not.toBe(addressWords(b));
  });

  it('parses only well-formed Sepolia codes', () => {
    const invite = {
      t: 'sqw-guardian-invite',
      v: 1,
      chainId: 11155111,
      safe,
      invite: 'x'.repeat(32),
      from: 'demo-user',
    };
    expect(parseQrPayload(JSON.stringify(invite))).toEqual(invite);
    for (const bad of [
      { ...invite, chainId: 1 },
      { ...invite, safe: '0x' + '0'.repeat(40) },
      { ...invite, invite: 'short' },
      { ...invite, t: 'other' },
    ])
      expect(() => parseQrPayload(JSON.stringify(bad))).toThrow();
    expect(() => parseQrPayload('not json')).toThrow();
    const request = {
      t: 'sqw-recovery-request',
      v: 1,
      chainId: 11155111,
      safe,
      module,
      newOwner: owner,
      nonce: '0',
    };
    expect(parseQrPayload(JSON.stringify(request))).toEqual(request);
    expect(() =>
      parseQrPayload(JSON.stringify({ ...request, module: a })),
    ).toThrow();
  });

  it('invite message is byte-identical to the backend one', () => {
    // Same literal as backend/tests/test_recovery.py::test_invite_message_format.
    expect(
      guardianInviteMessage({
        safe,
        invite: 'invite-id-0123456789',
        guardian: a,
      }),
    ).toBe(
      [
        'Swissquote Wallet: I agree to be a recovery guardian.',
        'Safe: 0x1111111111111111111111111111111111111111',
        'Guardian key: 0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa',
        'Invite: invite-id-0123456789',
        'Chain: 11155111',
        'This moves no funds.',
      ].join('\n'),
    );
  });
});

describe('offline guardian acceptance', () => {
  it('accepts only a signature by the guardian key over this invite', async () => {
    const { privateKeyToAccount } = await import('viem/accounts');
    const friend = privateKeyToAccount(generatePrivateKey());
    const safe = getAddress('0x' + '1'.repeat(40));
    const invite = 'invite-id-0123456789';
    const signature = await friend.signMessage({
      message: guardianInviteMessage({
        safe,
        invite,
        guardian: friend.address,
      }),
    });
    const payload = {
      t: 'sqw-guardian-accept' as const,
      v: 1 as const,
      chainId: 11155111,
      safe,
      invite,
      guardian: friend.address,
      signature,
    };
    expect(parseQrPayload(JSON.stringify(payload))).toEqual(payload);
    expect(await verifyGuardianAcceptance(payload)).toBe(true);
    expect(
      await verifyGuardianAcceptance({
        ...payload,
        invite: 'other-invite-0123456',
      }),
    ).toBe(false);
    expect(
      await verifyGuardianAcceptance({
        ...payload,
        guardian: privateKeyToAddress(generatePrivateKey()),
      }),
    ).toBe(false);
  });
});
