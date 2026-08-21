"""
API Router for Request Tracker
Handles logging and retrieving API request data from Test Assistant tabs
"""

from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy import case
from sqlalchemy.orm import Session
from app.database import get_db
from app.services.request_log_service import RequestLogService
from datetime import datetime
from typing import Optional, List

router = APIRouter(tags=["request-tracker"])


# ============================================================================
# Schemas
# ============================================================================

class RequestLogCreate:
    """Schema for creating a request log"""
    def __init__(
        self,
        id: str,
        timestamp: str,
        tab: str,
        method: str,
        url: str,
        endpoint: str,
        requestPayload: Optional[dict] = None,
        user: Optional[str] = None,
        sessionId: Optional[str] = None,
    ):
        self.id = id
        self.timestamp = timestamp
        self.tab = tab
        self.method = method
        self.url = url
        self.endpoint = endpoint
        self.requestPayload = requestPayload
        self.user = user
        self.sessionId = sessionId


class RequestLogUpdate:
    """Schema for updating a request log"""
    def __init__(
        self,
        responseStatus: Optional[int] = None,
        responseData: Optional[dict] = None,
        duration: Optional[int] = None,
        error: Optional[str] = None,
        promptTokens: Optional[int] = None,
        responseTokens: Optional[int] = None,
        totalTokens: Optional[int] = None,
    ):
        self.response_status = responseStatus
        self.response_data = responseData
        self.duration = duration
        self.error = error
        self.prompt_tokens = promptTokens
        self.response_tokens = responseTokens
        self.total_tokens = totalTokens


# ============================================================================
# Endpoints
# ============================================================================

@router.post("/logs")
async def create_log(log_data: dict, db: Session = Depends(get_db)):
    """
    Log a new request
    
    Expected payload:
    {
      "id": "timestamp-random",
      "timestamp": "2026-01-08T...",
      "tab": "testcases|visual|data|changes|unit|kb",
      "method": "GET|POST|PUT|DELETE",
      "url": "full_url",
      "endpoint": "/path",
      "requestPayload": {...},
      "user": "username",
      "sessionId": "session-id",
      "responseData": "Response text with [TOKEN_COUNTS:Prompt=435,Response=1401,Total=1836]"
    }
    
    Note: Token counts are automatically extracted from responseData if present
    in the format "[TOKEN_COUNTS:Prompt=435,Response=1401,Total=1836]"
    """
    try:
        # Validate required fields
        required_fields = ['id', 'tab', 'method', 'url', 'endpoint', 'timestamp']
        for field in required_fields:
            if field not in log_data or log_data[field] is None:
                raise ValueError(f'Missing required field: {field}')
        
        print(f'[RequestTracker] Creating log: id={log_data.get("id")}, tab={log_data.get("tab")}, method={log_data.get("method")}')
        log = RequestLogService.create_log(db, log_data)
        print(f'[RequestTracker] Log created successfully: {log.id}')
        return log.to_dict()
    except Exception as e:
        import traceback
        print(f'[RequestTracker ERROR] Failed to create log: {str(e)}')
        traceback.print_exc()
        raise HTTPException(status_code=400, detail=f'Failed to create log: {str(e)}')


@router.put("/logs/{log_id}")
async def update_log(log_id: str, update_data: dict, db: Session = Depends(get_db)):
    """
    Update a request log with response data
    
    Expected payload:
    {
      "response_status": 200,
      "response_data": {...},
      "duration": 1234,
      "error": null,
      "promptTokens": 435,
      "responseTokens": 1401,
      "totalTokens": 1836
    }
    
    Note: Token values are automatically extracted from response_data if present
    in the format "[TOKEN_COUNTS:Prompt=435,Response=1401,Total=1836]"
    """

    print(f'[RequestTracker] Updating log: id={log_id} with data keys: {list(update_data.keys())}')
    
    try:
        log = RequestLogService.update_log(db, log_id, update_data)
        if not log:
            raise HTTPException(status_code=404, detail="Log not found")
        return log.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/logs")
async def get_logs(
    tab: Optional[str] = Query(None),
    user: Optional[str] = Query(None),
    status: Optional[str] = Query(None, description="success|failed|pending"),
    start_time: Optional[str] = Query(None),
    end_time: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db)
):
    """
    Get request logs with optional filtering
    
    Query parameters:
    - tab: Filter by tab (testcases, visual, data, changes, unit, kb)
    - user: Filter by username
    - status: Filter by status (success, failed, pending)
    - start_time: ISO datetime (e.g., 2026-01-08T00:00:00)
    - end_time: ISO datetime
    - limit: Number of records (default 100, max 1000)
    - offset: Pagination offset (default 0)
    """
    try:
        start = None
        end = None
        
        if start_time:
            start = datetime.fromisoformat(start_time)
        if end_time:
            end = datetime.fromisoformat(end_time)

        logs, total = RequestLogService.get_logs(
            db,
            tab=tab,
            user=user,
            status=status,
            start_time=start,
            end_time=end,
            limit=limit,
            offset=offset
        )

        return {
            'logs': [log.to_dict() for log in logs],
            'total': total,
            'limit': limit,
            'offset': offset
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/stats")
async def get_stats(db: Session = Depends(get_db)):
    """Get statistics by tab"""
    try:
        stats = RequestLogService.get_stats_by_tab(db)
        return stats
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/summary")
async def get_summary(db: Session = Depends(get_db)):
    """Get overall summary"""
    try:
        summary = RequestLogService.get_summary(db)
        return summary
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/logs")
async def delete_logs(
    tab: Optional[str] = Query(None),
    older_than_days: Optional[int] = Query(None),
    db: Session = Depends(get_db)
):
    """
    Delete logs
    
    Query parameters:
    - tab: Delete logs for specific tab (optional)
    - older_than_days: Delete logs older than N days (optional)
    
    Examples:
    - DELETE /request-tracker/logs?older_than_days=30 -> Delete logs older than 30 days
    - DELETE /request-tracker/logs?tab=testcases -> Delete all logs for testcases tab
    - DELETE /request-tracker/logs -> Delete all logs (if no filters)
    """
    try:
        if not tab and not older_than_days:
            raise HTTPException(status_code=400, detail="Provide at least tab or older_than_days filter")
        
        count = RequestLogService.delete_logs(db, tab=tab, older_than_days=older_than_days)
        return {'deleted': count}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/analytics/report")
async def get_analytics_report(
    days: int = Query(30),
    db: Session = Depends(get_db)
):
    """
    Get management-level analytics report
    
    Returns:
    - requests_per_day: Daily request count for last N days
    - top_endpoints: Most frequently triggered endpoints
    - top_users: Users with most requests
    - tab_distribution: Request count by tab
    - status_distribution: Request count by status (success/failed)
    
    Query parameters:
    - days: Number of days to include (default 30)
    """
    try:
        from sqlalchemy import func, desc
        from datetime import datetime, timedelta
        from app.models.request_log import RequestLog, TabEnum
        
        start_date = datetime.utcnow() - timedelta(days=days)
        
        # Requests per day
        daily_requests = db.query(
            func.date(RequestLog.timestamp).label('date'),
            func.count(RequestLog.id).label('count')
        ).filter(RequestLog.timestamp >= start_date).group_by(
            func.date(RequestLog.timestamp)
        ).order_by('date').all()
        
        requests_per_day = [
            {'date': str(r[0]), 'count': r[1]} for r in daily_requests
        ]
        
        # Top endpoints
        top_endpoints = db.query(
            RequestLog.endpoint,
            func.count(RequestLog.id).label('count'),
            RequestLog.tab
        ).filter(RequestLog.timestamp >= start_date).group_by(
            RequestLog.endpoint, RequestLog.tab
        ).order_by(desc('count')).limit(10).all()
        
        top_endpoints_list = [
            {'endpoint': r[0], 'count': r[1], 'tab': r[2]} for r in top_endpoints
        ]
        
        # Top users
        top_users = db.query(
            RequestLog.user,
            func.count(RequestLog.id).label('count'),
            func.sum(case(( (RequestLog.response_status >= 200) & (RequestLog.response_status < 300), 1), else_=0)).label('success_count')
        ).filter(
            RequestLog.timestamp >= start_date,
            RequestLog.user != None
        ).group_by(RequestLog.user).order_by(desc('count')).limit(10).all()
        
        top_users_list = [
            {'user': r[0], 'count': r[1], 'success': r[2] or 0} for r in top_users
        ]
        
        # Tab distribution
        tab_distribution = db.query(
            RequestLog.tab,
            func.count(RequestLog.id).label('count')
        ).filter(RequestLog.timestamp >= start_date).group_by(
            RequestLog.tab
        ).all()
        
        tab_dist = [
            {'tab': r[0], 'count': r[1]} for r in tab_distribution
        ]
        
        # Status distribution
        status_dist = db.query(
            case(
                ((RequestLog.response_status >= 200) & (RequestLog.response_status < 300), 'success'),
                (RequestLog.error != None, 'error'),
                else_='pending'
            ).label('status'),
            func.count(RequestLog.id).label('count')
        ).filter(RequestLog.timestamp >= start_date).group_by('status').all()
        
        status_distribution = [
            {'status': r[0], 'count': r[1]} for r in status_dist
        ]
        
        # Summary stats
        total = db.query(func.count(RequestLog.id)).filter(
            RequestLog.timestamp >= start_date
        ).scalar()
        
        success_count = db.query(func.count(RequestLog.id)).filter(
            RequestLog.timestamp >= start_date,
            RequestLog.response_status >= 200,
            RequestLog.response_status < 300
        ).scalar()
        
        error_count = db.query(func.count(RequestLog.id)).filter(
            RequestLog.timestamp >= start_date,
            RequestLog.error != None
        ).scalar()
        
        return {
            'summary': {
                'total_requests': total or 0,
                'successful': success_count or 0,
                'failed': error_count or 0,
                'period_days': days
            },
            'requests_per_day': requests_per_day,
            'top_endpoints': top_endpoints_list,
            'top_users': top_users_list,
            'tab_distribution': tab_dist,
            'status_distribution': status_distribution
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))




@router.get("/token-stats")
async def get_token_stats(
    days: int = Query(1),
    db: Session = Depends(get_db)
):
    """
    Get token usage statistics
    
    Returns per-user and per-session token usage for the specified period
    
    Query parameters:
    - days: Number of days to include (default 1 - today)
    
    Response:
    {
        "period_days": 1,
        "total_tokens": 5000,
        "total_prompt_tokens": 2000,
        "total_response_tokens": 3000,
        "per_user": [
            {
                "user": "username",
                "total_tokens": 1000,
                "prompt_tokens": 400,
                "response_tokens": 600,
                "request_count": 5
            }
        ],
        "per_session": [
            {
                "session_id": "sess-xxx",
                "user": "username",
                "total_tokens": 500,
                "prompt_tokens": 200,
                "response_tokens": 300,
                "request_count": 2
            }
        ],
        "by_tab": [
            {
                "tab": "testcases",
                "total_tokens": 2000,
                "prompt_tokens": 800,
                "response_tokens": 1200
            }
        ]
    }
    """
    try:
        from sqlalchemy import func, desc
        from datetime import datetime, timedelta
        from app.models.request_log import RequestLog
        
        # Calculate date range
        end_date = datetime.utcnow()
        start_date = end_date - timedelta(days=days)
        
        # Total tokens
        total_stats = db.query(
            func.coalesce(func.sum(RequestLog.total_tokens), 0).label('total_tokens'),
            func.coalesce(func.sum(RequestLog.prompt_tokens), 0).label('prompt_tokens'),
            func.coalesce(func.sum(RequestLog.response_tokens), 0).label('response_tokens')
        ).filter(RequestLog.timestamp >= start_date).first()
        
        # Per user stats
        per_user = db.query(
            RequestLog.user.label('user'),
            func.coalesce(func.sum(RequestLog.total_tokens), 0).label('total_tokens'),
            func.coalesce(func.sum(RequestLog.prompt_tokens), 0).label('prompt_tokens'),
            func.coalesce(func.sum(RequestLog.response_tokens), 0).label('response_tokens'),
            func.count(RequestLog.id).label('request_count')
        ).filter(
            RequestLog.timestamp >= start_date,
            RequestLog.user != None
        ).group_by(RequestLog.user).order_by(desc('total_tokens')).limit(10).all()
        
        # Per session stats
        per_session = db.query(
            RequestLog.session_id.label('session_id'),
            RequestLog.user.label('user'),
            func.coalesce(func.sum(RequestLog.total_tokens), 0).label('total_tokens'),
            func.coalesce(func.sum(RequestLog.prompt_tokens), 0).label('prompt_tokens'),
            func.coalesce(func.sum(RequestLog.response_tokens), 0).label('response_tokens'),
            func.count(RequestLog.id).label('request_count')
        ).filter(
            RequestLog.timestamp >= start_date,
            RequestLog.session_id != None
        ).group_by(RequestLog.session_id, RequestLog.user).order_by(desc('total_tokens')).limit(10).all()
        
        # By tab
        by_tab = db.query(
            RequestLog.tab.label('tab'),
            func.coalesce(func.sum(RequestLog.total_tokens), 0).label('total_tokens'),
            func.coalesce(func.sum(RequestLog.prompt_tokens), 0).label('prompt_tokens'),
            func.coalesce(func.sum(RequestLog.response_tokens), 0).label('response_tokens')
        ).filter(RequestLog.timestamp >= start_date).group_by(RequestLog.tab).order_by(desc('total_tokens')).all()
        
        return {
            'period_days': days,
            'total_tokens': total_stats[0] or 0,
            'total_prompt_tokens': total_stats[1] or 0,
            'total_response_tokens': total_stats[2] or 0,
            'per_user': [
                {
                    'user': r[0],
                    'total_tokens': int(r[1] or 0),
                    'prompt_tokens': int(r[2] or 0),
                    'response_tokens': int(r[3] or 0),
                    'request_count': r[4]
                } for r in per_user
            ],
            'per_session': [
                {
                    'session_id': r[0],
                    'user': r[1],
                    'total_tokens': int(r[2] or 0),
                    'prompt_tokens': int(r[3] or 0),
                    'response_tokens': int(r[4] or 0),
                    'request_count': r[5]
                } for r in per_session
            ],
            'by_tab': [
                {
                    'tab': str(r[0]),
                    'total_tokens': int(r[1] or 0),
                    'prompt_tokens': int(r[2] or 0),
                    'response_tokens': int(r[3] or 0)
                } for r in by_tab
            ]
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/prune")
async def prune_logs(
    keep_days: int = Query(30),
    max_logs: int = Query(10000),
    db: Session = Depends(get_db)
):
    """
    Prune old logs to maintain database size
    
    Query parameters:
    - keep_days: Keep logs from last N days (default 30)
    - max_logs: Maximum logs to keep (default 10000)
    
    Deletes logs older than keep_days and then oldest logs if count exceeds max_logs
    """
    try:
        deleted = RequestLogService.prune_old_logs(db, keep_days=keep_days, max_logs=max_logs)
        return {'pruned': deleted}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
