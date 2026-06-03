import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import auth

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("scada-api")

app = FastAPI(title="SCADA MML API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)


@app.get("/health")
async def health() -> dict[str, str]:
    """Liveness probe so NSSM / monitoring can confirm the service is up."""
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    logger.info("Starting SCADA MML API on 0.0.0.0:8088")
    uvicorn.run(app, host="0.0.0.0", port=8088)
