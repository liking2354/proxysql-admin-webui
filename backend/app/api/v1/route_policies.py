"""Per-server route policy & misroute detection API endpoints.

Lets each ProxySQL instance declare its own intended read/write routing
strategy (or none at all), and provides an on-demand check against live
ProxySQL query digest stats to catch SQL that violates that strategy
(e.g. a write silently landing on a hostgroup declared read_only).
"""
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field
from typing import Literal

from app.middleware import get_current_user
from app.schemas.route_policy import (
    RoutePolicyListResponse,
    RoutePolicyItem,
    MisrouteCheckResponse,
)
from app.schemas.response import MessageResponse, HTTPError, RESPONSE_AUTH, RESPONSE_404
from app.services.route_policy_service import route_policy_service
from app.utils.db_helpers import get_proxysql_credentials

router = APIRouter(tags=["Route Policies"])


class UpsertPolicyRequest(BaseModel):
    """Request to declare (or update) a hostgroup's intended role."""
    hostgroup_id: int = Field(description="Target hostgroup ID.", examples=[10])
    policy: Literal["write_only", "read_only"] = Field(
        description="write_only: this hostgroup should only receive DML/DDL/locking "
                    "reads. read_only: this hostgroup should only receive plain SELECTs.",
    )
    enabled: bool = Field(default=True, description="Whether to actively check this policy.")


@router.get(
    "/{server_id}",
    response_model=RoutePolicyListResponse,
    responses={**RESPONSE_AUTH},
    summary="List route policies",
    description="List all hostgroup role declarations for a server.",
)
async def list_policies(server_id: str, user=Depends(get_current_user)):
    return {"policies": await route_policy_service.list_policies(server_id)}


@router.put(
    "/{server_id}",
    response_model=RoutePolicyItem,
    responses={**RESPONSE_AUTH},
    summary="Create or update a route policy",
    description="Declare (or update) the intended role of a hostgroup for this server.",
)
async def upsert_policy(server_id: str, req: UpsertPolicyRequest, user=Depends(get_current_user)):
    return await route_policy_service.upsert_policy(
        server_id=server_id,
        hostgroup_id=req.hostgroup_id,
        policy=req.policy,
        enabled=req.enabled,
    )


@router.delete(
    "/{server_id}/{policy_id}",
    response_model=MessageResponse,
    responses={
        200: {"description": "Policy deleted."},
        404: {"description": "Policy not found.", "model": HTTPError},
        **RESPONSE_AUTH,
    },
    summary="Delete a route policy",
)
async def delete_policy(server_id: str, policy_id: int, user=Depends(get_current_user)):
    deleted = await route_policy_service.delete_policy(server_id, policy_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Policy not found")
    return {"message": "Policy deleted"}


@router.get(
    "/{server_id}/check",
    response_model=MisrouteCheckResponse,
    responses={
        200: {"description": "Check completed (see violations list)."},
        500: {"description": "Check failed — ProxySQL unreachable.", "model": HTTPError},
        **RESPONSE_AUTH,
    },
    summary="Run misroute check now",
    description="Query live stats_mysql_query_digest and flag any SQL that "
                "violates this server's declared route policies.",
)
async def check_misroute(server_id: str, user=Depends(get_current_user)):
    host, port, admin_user, password = await get_proxysql_credentials(server_id)
    try:
        return await route_policy_service.check_misroute(server_id, host, port, admin_user, password)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Misroute check failed: {str(e)}")


@router.post(
    "/{server_id}/reset-stats",
    response_model=MessageResponse,
    responses={
        200: {"description": "Digest stats cleared."},
        500: {"description": "Reset failed — ProxySQL unreachable.", "model": HTTPError},
        **RESPONSE_AUTH,
    },
    summary="Reset query digest stats",
    description="Clear ProxySQL's stats_mysql_query_digest counters after a "
                "violation has been investigated/fixed, so stale counts stop "
                "re-triggering alerts.",
)
async def reset_stats(server_id: str, user=Depends(get_current_user)):
    host, port, admin_user, password = await get_proxysql_credentials(server_id)
    try:
        await route_policy_service.reset_digest_stats(host, port, admin_user, password)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Reset failed: {str(e)}")
    return {"message": "Digest stats reset"}
