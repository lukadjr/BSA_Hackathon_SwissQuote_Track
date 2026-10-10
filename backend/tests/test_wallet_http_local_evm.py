"""Actual Node wallet-core, HTTP API and separate single treasury worker processes."""

import json
import os
import socket
import subprocess
import time
import urllib.request
from pathlib import Path

import pytest

from app.funding.chain import ROOT

pytestmark = pytest.mark.skipif(
    not os.getenv("FUNDING_EVM_FIXTURE"), reason="optional local EVM fixture not running"
)


def test_full_wallet_adapter_through_real_http_api_and_worker(tmp_path):
    fixture_path = os.environ["FUNDING_EVM_FIXTURE"]
    fixture = json.loads(Path(fixture_path).read_text())
    with socket.socket() as port:
        port.bind(("127.0.0.1", 0))
        number = port.getsockname()[1]
    api = f"http://127.0.0.1:{number}"
    env = {
        **os.environ,
        "SEPOLIA_RPC_URL": fixture["rpc_url"],
        "MOCK_USER_ID": "alice",
        "MOCK_KYC_STATUS": "verified",
        "MOCK_ACCESS_TOKEN": "local-http-only-token-" + "x" * 40,
        "DATABASE_URL": f"sqlite:///{tmp_path / 'bank.sqlite'}",
        "SWISSQUOTE_TREASURY_ADDRESS": fixture["treasury_address"],
        "ERC20_TEST_ADDRESS": fixture["token"],
        "RECOVERY_ALLOW_DEMO": "true",
        "FUNDING_ALLOW_UNPROTECTED_DEMO": "false",
        "RECOVERY_WATCHER_SECONDS": "0",
        "TREASURY_JOURNAL_PATH": str(tmp_path / "journal.sqlite"),
        "PYTHONPATH": str(ROOT / "backend"),
    }
    api_env = {key: value for key, value in env.items() if key != "SWISSQUOTE_TREASURY_PRIVATE_KEY"}
    worker_env = {**env, "SWISSQUOTE_TREASURY_PRIVATE_KEY": fixture["treasury_key"]}
    python = str(ROOT / "backend/.venv/bin/python")
    processes = []
    with (tmp_path / "process.log").open("w") as log:
        try:
            processes.append(
                subprocess.Popen(
                    [
                        python,
                        "-m",
                        "uvicorn",
                        "app.main:app",
                        "--host",
                        "127.0.0.1",
                        "--port",
                        str(number),
                    ],
                    cwd=ROOT,
                    env=api_env,
                    stdout=log,
                    stderr=log,
                )
            )
            deadline = time.monotonic() + 20
            while True:
                assert processes[0].poll() is None, "API failed to start"
                try:
                    with urllib.request.urlopen(api + "/health", timeout=1) as response:
                        assert response.status == 200
                    break
                except OSError:
                    if time.monotonic() > deadline:
                        raise AssertionError("API startup timed out") from None
                    time.sleep(0.1)
            processes.append(
                subprocess.Popen(
                    [python, "-m", "app.funding.worker"],
                    cwd=ROOT,
                    env=worker_env,
                    stdout=log,
                    stderr=log,
                )
            )
            result = subprocess.run(
                ["node", "--import", "tsx", "scripts/treasury-wallet-local-e2e.ts"],
                cwd=ROOT,
                input=json.dumps(
                    {"api": api, "token": env["MOCK_ACCESS_TOKEN"], "fixture": fixture_path}
                ),
                capture_output=True,
                text=True,
                timeout=150,
            )
            assert result.returncode == 0, result.stderr
            assert "acceptance passed" in result.stdout
        finally:
            for process in reversed(processes):
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
