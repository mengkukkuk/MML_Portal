import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import alarms
import auth
import dashboards
import datasources
import db
import events
import panels
import readings
import schema
import tags
import users

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("mml-api")

app = FastAPI(title="SCADA MML API")

# Allowed origins — must be explicit when allow_credentials=True (cannot use "*")
_ORIGINS = [o.strip() for o in os.getenv(
    "CORS_ORIGINS",
    "http://localhost:5173,http://127.0.0.1:5173"  # Vite dev server
).split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ORIGINS,
    allow_credentials=True,   # required for cookies
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(users.router)
app.include_router(readings.router)
app.include_router(tags.router)
app.include_router(schema.router)
app.include_router(panels.router)
app.include_router(dashboards.router)
app.include_router(datasources.router)
app.include_router(events.router)
app.include_router(alarms.router)


@app.on_event("startup")
def _ensure_tables() -> None:
    """Create the dashboard_panels + dashboards + datasources tables on boot so
    the Live grid and saved connections can persist. Dashboards must run after
    panels (it alters dashboard_panels)."""
    db.init_panels_table()
    db.init_dashboards_table()
    db.init_datasources_table()


@app.get("/health")
async def health() -> dict[str, str]:
    """Liveness probe so NSSM / monitoring can confirm the service is up."""
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    logger.info("Starting SCADA MML API on 0.0.0.0:8088")
    uvicorn.run(app, host="0.0.0.0", port=8088)
