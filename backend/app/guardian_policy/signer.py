"""Swissquote guardian signer (testnet).

The key lives in its own file (default backend/data/, git-ignored), outside the
database and never in an API response. It can only sign the recovery approval
built here from on-chain data; it never signs a client-supplied hash and has no
power to spend. Production: an HSM/KMS or an institutional Safe.

Create the keys once:  python -m app.guardian_policy.signer init
"""

import os
import sys
from pathlib import Path

from eth_account import Account
from eth_account.messages import encode_typed_data

from app.chain import recovery_typed_data

DATA_DIR = Path(__file__).resolve().parents[2] / "data"


class SignerUnavailable(Exception):
    pass


def _key_file(env: str, default: str) -> Path:
    return Path(os.getenv(env, str(DATA_DIR / default)))


def _read_key(path: Path) -> str:
    try:
        key = path.read_text().strip()
    except OSError as exc:
        raise SignerUnavailable(f"{path.name} is missing") from exc
    if not (key.startswith("0x") and len(key) == 66):
        raise SignerUnavailable(f"{path.name} is invalid")
    return key


def guardian_key_file() -> Path:
    return _key_file("SWISSQUOTE_GUARDIAN_KEY_FILE", "swissquote-guardian.key")


def relayer_key_file() -> Path:
    return _key_file("RELAYER_KEY_FILE", "relayer.key")


def guardian_address() -> str:
    return Account.from_key(_read_key(guardian_key_file())).address.lower()


def relayer_key() -> str:
    """Pays gas for public recovery calls. Holds testnet ETH only."""
    return _read_key(relayer_key_file())


def relayer_address() -> str:
    return Account.from_key(relayer_key()).address.lower()


def sign_recovery_approval(module: str, safe: str, new_owner: str, nonce: int) -> str:
    message = encode_typed_data(full_message=recovery_typed_data(module, safe, new_owner, nonce))
    signed = Account.from_key(_read_key(guardian_key_file())).sign_message(message)
    return "0x" + signed.signature.hex().removeprefix("0x")


def _init() -> None:
    for path in (guardian_key_file(), relayer_key_file()):
        if path.exists():
            print(f"{path.name}: exists ({Account.from_key(_read_key(path)).address})")
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        account = Account.create()
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write("0x" + account.key.hex().removeprefix("0x"))
        print(f"{path.name}: created {account.address}")
    print("Fund the relayer address with Sepolia ETH. Never fund these keys on mainnet.")


if __name__ == "__main__":
    if sys.argv[1:] == ["init"]:
        _init()
    else:
        print("usage: python -m app.guardian_policy.signer init")
