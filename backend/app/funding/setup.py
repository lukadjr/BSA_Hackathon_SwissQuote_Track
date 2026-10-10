"""Create the test treasury exactly once; never print a private key."""

import argparse
import os
from pathlib import Path

from dotenv import dotenv_values, set_key
from eth_account import Account

from app.config import ENV_PATH
from app.funding.chain import USDC


def initialize(path=ENV_PATH):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
    os.chmod(path, 0o600)
    values = dotenv_values(path)
    key = values.get("SWISSQUOTE_TREASURY_PRIVATE_KEY")
    address = values.get("SWISSQUOTE_TREASURY_ADDRESS")
    if address and not key:
        raise ValueError(
            "Existing treasury address has no key; restore its key instead of replacing it."
        )
    account = Account.from_key(key) if key else Account.create()
    if address and address.lower() != account.address.lower():
        raise ValueError("Treasury key and address do not match; configuration was not replaced.")
    defaults = {
        "SWISSQUOTE_TREASURY_PRIVATE_KEY": "0x" + account.key.hex().removeprefix("0x"),
        "SWISSQUOTE_TREASURY_ADDRESS": account.address,
        "SEPOLIA_RPC_URL": "https://ethereum-sepolia-rpc.publicnode.com",
        "ERC20_TEST_ADDRESS": USDC,
        "DATABASE_URL": "sqlite:///" + str(path.parent / "data/swissquote-demo.db"),
        "TREASURY_JOURNAL_PATH": str(path.parent / "data/treasury.sqlite"),
        "FUNDING_ALLOW_UNPROTECTED_DEMO": "false",
        "MOCK_USER_ID": "demo-user",
        "MOCK_KYC_STATUS": "pending",
        "MOCK_ACCESS_TOKEN": __import__("secrets").token_urlsafe(32),
    }
    (path.parent / "data").mkdir(exist_ok=True)
    for name, value in defaults.items():
        if not values.get(name):
            set_key(path, name, value)
    os.chmod(path, 0o600)
    return account.address


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=ENV_PATH)
    args = parser.parse_args()
    try:
        address = initialize(args.env_file)
    except Exception:
        raise SystemExit(
            "Treasury setup failed; check existing configuration. No key is printed."
        ) from None
    print(f"Swissquote demo treasury: {address}")
    print(f"Configuration saved to {args.env_file}. Keep a private backup; do not commit it.")
    print("Fund this address manually with Ethereum Sepolia ETH and Circle Sepolia test USDC.")
    print(
        "Bank KYC defaults to pending; recovery verification is required unless explicitly opted out for tests."
    )


if __name__ == "__main__":
    main()
