# guardians

Flat **2 of 3** guardians on the Candide recovery module (decided 2026-10-10):

- **backup**: key derived from the user's 12-word phrase (`createBackupPhrase`,
  `signApprovalWithPhrase`), never stored on the phone;
- **Swissquote**: the backend's guardian signer;
- **friend**: a guardian key created in the friend's own app, added by QR invite.

Any two can recover, including backup + friend without Swissquote. Code lives in
[`../recovery`](../recovery/README.md); see [docs/recovery.md](../../../docs/recovery.md).
