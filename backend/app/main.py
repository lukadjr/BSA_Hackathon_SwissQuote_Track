"""Health-only starter; business endpoints are left for the team."""

from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict

app = FastAPI(
    title="Swissquote Demo API",
    version="0.1.0",
    description="Hackathon starter. Wallet and recovery endpoints are not implemented.",
)


class HealthResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: str
    service: str


@app.get("/health", response_model=HealthResponse, tags=["health"])
def health() -> HealthResponse:
    return HealthResponse(status="ok", service="swissquote-demo")
