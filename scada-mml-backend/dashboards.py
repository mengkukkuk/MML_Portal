"""Dashboard endpoints for the multi-board Live grid.

A dashboard groups panels (dashboard_panels.dashboard_id) so the Live page can
host several named boards. Reads are open to any authenticated user; writes
(create / update / delete) require an admin token. Deleting a dashboard cascades
to its panels (ON DELETE CASCADE in the schema).
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

import db
from auth import get_current_user, require_admin

router = APIRouter(prefix="/api/dashboards", tags=["dashboards"])


class DashboardOut(BaseModel):
    id: int
    title: str
    position: int
    created_at: datetime


class DashboardIn(BaseModel):
    title: str = Field(..., min_length=1)
    position: int = 0


@router.get("", response_model=list[DashboardOut])
def list_dashboards(_user: dict = Depends(get_current_user)):
    return db.list_dashboards()


@router.post("", response_model=DashboardOut, status_code=status.HTTP_201_CREATED)
def create_dashboard(body: DashboardIn, _admin: dict = Depends(require_admin)):
    return db.create_dashboard(body.title.strip(), body.position)


@router.put("/{dashboard_id}", response_model=DashboardOut)
def update_dashboard(dashboard_id: int, body: DashboardIn, _admin: dict = Depends(require_admin)):
    dash = db.update_dashboard(dashboard_id, body.title.strip())
    if dash is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found")
    return dash


@router.delete("/{dashboard_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_dashboard(dashboard_id: int, _admin: dict = Depends(require_admin)):
    if not db.delete_dashboard(dashboard_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found")
