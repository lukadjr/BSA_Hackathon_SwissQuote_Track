"""Load backend/.env independently of cwd; the API does not import the treasury key."""

import os
from pathlib import Path

from dotenv import dotenv_values

ENV_PATH = Path(__file__).resolve().parents[1] / ".env"


def load_environment(*, treasury=False):
    for key, value in dotenv_values(ENV_PATH).items():
        if value is not None and (treasury or key != "SWISSQUOTE_TREASURY_PRIVATE_KEY"):
            os.environ.setdefault(key, value)
