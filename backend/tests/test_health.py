from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_without_external_services():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "swissquote-demo"}


def test_business_routes_are_not_exposed():
    routes = client.get("/openapi.json").json()["paths"]
    assert set(routes) == {"/health"}
