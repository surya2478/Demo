"""
Request Log database operations
"""

from sqlalchemy.orm import Session
from sqlalchemy import desc, and_, or_
from app.models.request_log import RequestLog, TabEnum
from datetime import datetime, timedelta, timezone
from typing import Optional, List, Tuple
import json
import re


class RequestLogService:
    """Service for request log database operations"""

    @staticmethod
    def extract_token_counts(response_text: str) -> Tuple[Optional[int], Optional[int], Optional[int]]:
        """
        Extract token counts from response text
        Expected format: "[TOKEN_COUNTS:Prompt=435,Response=1401,Total=1836]"
        Returns: (prompt_tokens, response_tokens, total_tokens)
        """
        if not response_text:
            return None, None, None
        
        try:
            response_str = str(response_text)
            pattern = r'\[TOKEN_COUNTS:Prompt=(\d+),Response=(\d+),Total=(\d+)\]'
            match = re.search(pattern, response_str)
            
            if match:
                prompt = int(match.group(1))
                response = int(match.group(2))
                total = int(match.group(3))
                return prompt, response, total
        except Exception as e:
            print(f'[RequestLogService] Error extracting token counts: {str(e)}')
        
        return None, None, None

    @staticmethod
    def create_log(db: Session, log_data: dict) -> RequestLog:
        """Create a new request log"""
        try:
            # Parse timestamp - Convert to Dubai time (UTC+4)
            timestamp = None
            dubai_tz = timezone(timedelta(hours=4))
            if 'timestamp' in log_data and log_data['timestamp']:
                try:
                    utc_time = datetime.fromisoformat(log_data['timestamp'].replace('Z', '+00:00'))
                    timestamp = utc_time.astimezone(dubai_tz)
                except:
                    utc_time = datetime.now(timezone.utc)
                    timestamp = utc_time.astimezone(dubai_tz)
            else:
                utc_time = datetime.now(timezone.utc)
                timestamp = utc_time.astimezone(dubai_tz)
            
            # Parse tab enum
            tab_value = log_data.get('tab', 'testcases')
            if isinstance(tab_value, str):
                tab = TabEnum(tab_value)
            else:
                tab = tab_value
            
            # Serialize request payload to JSON string (SQLite doesn't support dicts)
            request_payload = log_data.get('requestPayload') or log_data.get('request_payload')
            if request_payload is not None:
                if isinstance(request_payload, dict):
                    request_payload = json.dumps(request_payload)
            
            # Serialize response data to JSON string
            response_data = log_data.get('responseData') or log_data.get('response_data')
            if response_data is not None:
                if isinstance(response_data, dict):
                    response_data = json.dumps(response_data)
            
            # Extract token counts from response data (if not explicitly provided)
            prompt_tokens = log_data.get('promptTokens') or log_data.get('prompt_tokens')
            response_tokens = log_data.get('responseTokens') or log_data.get('response_tokens')
            total_tokens = log_data.get('totalTokens') or log_data.get('total_tokens')
            
            # If tokens not provided, try to extract from response_data
            if not total_tokens and response_data:
                extracted_prompt, extracted_response, extracted_total = RequestLogService.extract_token_counts(response_data)
                if extracted_total:
                    prompt_tokens = extracted_prompt
                    response_tokens = extracted_response
                    total_tokens = extracted_total
            
            log = RequestLog(
                id=log_data.get('id'),
                tab=tab,
                method=log_data.get('method'),
                url=log_data.get('url'),
                endpoint=log_data.get('endpoint'),
                request_payload=request_payload,
                response_status=log_data.get('responseStatus') or log_data.get('response_status'),
                response_data=response_data,
                duration=log_data.get('duration'),
                prompt_tokens=prompt_tokens,
                response_tokens=response_tokens,
                total_tokens=total_tokens,
                error=log_data.get('error'),
                user=log_data.get('user'),
                session_id=log_data.get('sessionId') or log_data.get('session_id'),
                timestamp=timestamp
            )
            print(f'[RequestLogService] Adding log to session: {log.id}')
            db.add(log)
            print(f'[RequestLogService] Committing to database')
            db.commit()
            print(f'[RequestLogService] Refreshing log')
            db.refresh(log)
            print(f'[RequestLogService] Log saved successfully: {log.id}')
            return log
        except Exception as e:
            import traceback
            print(f'[RequestLogService ERROR] Failed to create log: {str(e)}')
            traceback.print_exc()
            db.rollback()
            raise

    @staticmethod
    def update_log(db: Session, log_id: str, update_data: dict) -> Optional[RequestLog]:
        """Update an existing log with response data"""
        log = db.query(RequestLog).filter(RequestLog.id == log_id).first()
        if not log:
            return None

        key_map = {
            'response_status': 'response_status',
            'responseStatus': 'response_status',
            'response_data': 'response_data',
            'responseData': 'response_data',
            'requestPayload': 'request_payload',
            'request_payload': 'request_payload',
            'sessionId': 'session_id',
            'session_id': 'session_id',
            'promptTokens': 'prompt_tokens',
            'prompt_tokens': 'prompt_tokens',
            'responseTokens': 'response_tokens',
            'response_tokens': 'response_tokens',
            'totalTokens': 'total_tokens',
            'total_tokens': 'total_tokens',
        }

        for key, value in update_data.items():
            mapped_key = key_map.get(key, key)
            if mapped_key == 'tab':
                value = TabEnum(value) if isinstance(value, str) else value
            # Serialize dicts to JSON for SQLite
            if mapped_key in ['request_payload', 'response_data'] and isinstance(value, dict):
                value = json.dumps(value)
            if hasattr(log, mapped_key):
                setattr(log, mapped_key, value)

        # Extract token counts from response_data if not explicitly provided
        if not log.total_tokens and log.response_data:
            extracted_prompt, extracted_response, extracted_total = RequestLogService.extract_token_counts(log.response_data)
            if extracted_total:
                log.prompt_tokens = extracted_prompt
                log.response_tokens = extracted_response
                log.total_tokens = extracted_total

        # Update timestamp to Dubai time (UTC+4)
        dubai_tz = timezone(timedelta(hours=4))
        log.updated_at = datetime.now(dubai_tz).replace(tzinfo=None)
        db.commit()
        db.refresh(log)
        return log

    @staticmethod
    def get_logs(
        db: Session,
        tab: Optional[str] = None,
        user: Optional[str] = None,
        status: Optional[str] = None,
        start_time: Optional[datetime] = None,
        end_time: Optional[datetime] = None,
        limit: int = 100,
        offset: int = 0
    ) -> tuple[List[RequestLog], int]:
        """Get logs with optional filters"""
        query = db.query(RequestLog)

        # Tab filter
        if tab:
            query = query.filter(RequestLog.tab == TabEnum(tab))

        # User filter
        if user:
            query = query.filter(RequestLog.user == user)

        # Status filter
        if status == 'success':
            query = query.filter(
                and_(
                    RequestLog.response_status >= 200,
                    RequestLog.response_status < 300,
                    RequestLog.error.is_(None)
                )
            )
        elif status == 'failed':
            query = query.filter(
                or_(
                    RequestLog.error.isnot(None),
                    RequestLog.response_status >= 400
                )
            )
        elif status == 'pending':
            query = query.filter(
                and_(
                    RequestLog.response_status.is_(None),
                    RequestLog.error.is_(None)
                )
            )

        # Time range filter
        if start_time:
            query = query.filter(RequestLog.timestamp >= start_time)
        if end_time:
            query = query.filter(RequestLog.timestamp <= end_time)

        # Get total count before limit/offset
        total = query.count()

        # Sort by newest first and apply pagination
        logs = query.order_by(desc(RequestLog.timestamp)).offset(offset).limit(limit).all()

        return logs, total

    # --- Automation Module: server-side token quota ---------------------------
    # The quota check in the Test Assistant tabs runs entirely in the browser
    # (see TestCases.tsx: it compares userTokensUsed against token_allocation
    # and simply shows a warning). Nothing stops a caller ignoring it.
    #
    # An automation run costs real server CPU, memory and browser time, so the
    # Automation Module has to enforce the quota where it cannot be bypassed.
    # That needs a per-user total, which until now existed only inside the
    # /request-tracker/token-stats endpoint -- as part of a top-10 grouped
    # dashboard query, not callable from anywhere else.
    #
    # Added here rather than refactored out of that endpoint: this is a
    # different query (one user, lifetime by default, no grouping), so the
    # endpoint keeps working exactly as before and nothing existing changes.
    @staticmethod
    def get_user_token_usage(
        db: Session,
        username: str,
        days: Optional[int] = None,
    ) -> dict:
        """Total tokens consumed by one user.

        days=None (the default) totals the user's whole history, matching what
        the frontend compares against users.token_allocation. Pass a number to
        restrict to a rolling window instead.

        Rows predating token tracking have NULL token columns; coalesce treats
        those as 0 rather than returning None, so a caller never has to guard.
        """
        from sqlalchemy import func

        query = db.query(
            func.coalesce(func.sum(RequestLog.total_tokens), 0),
            func.coalesce(func.sum(RequestLog.prompt_tokens), 0),
            func.coalesce(func.sum(RequestLog.response_tokens), 0),
            func.count(RequestLog.id),
        ).filter(RequestLog.user == username)

        if days is not None:
            cutoff = datetime.utcnow() - timedelta(days=days)
            query = query.filter(RequestLog.timestamp >= cutoff)

        total, prompt, response, count = query.first()

        return {
            "user": username,
            "period_days": days,
            "total_tokens": int(total or 0),
            "prompt_tokens": int(prompt or 0),
            "response_tokens": int(response or 0),
            "request_count": int(count or 0),
        }

    @staticmethod
    def check_token_quota(
        db: Session,
        username: str,
        allocation: Optional[int],
        is_admin: bool = False,
    ) -> dict:
        """Whether `username` may start another billable action.

        Returns a verdict rather than raising, so the caller decides whether a
        breach blocks the action or only warns. Keys: allowed, used, allocation,
        remaining, reason.

        Admins and users with no allocation set are unlimited -- the same rule
        the frontend applies, kept identical here so the two cannot disagree
        about who is over quota.
        """
        usage = RequestLogService.get_user_token_usage(db, username)
        used = usage["total_tokens"]

        if is_admin or not allocation or allocation <= 0:
            return {
                "allowed": True,
                "used": used,
                "allocation": allocation,
                "remaining": None,
                "reason": "unlimited",
            }

        remaining = allocation - used
        if remaining <= 0:
            return {
                "allowed": False,
                "used": used,
                "allocation": allocation,
                "remaining": 0,
                "reason": (
                    f"Token allocation exhausted: {used:,} of {allocation:,} used. "
                    "Ask an administrator to increase your allocation."
                ),
            }

        return {
            "allowed": True,
            "used": used,
            "allocation": allocation,
            "remaining": remaining,
            "reason": "within allocation",
        }

    @staticmethod
    def get_stats_by_tab(db: Session) -> dict:
        """Get statistics grouped by tab"""
        logs = db.query(RequestLog).all()
        stats = {}

        for tab in TabEnum:
            tab_logs = [log for log in logs if log.tab == tab]
            successful = len([log for log in tab_logs if log.response_status and 200 <= log.response_status < 300])
            failed = len([log for log in tab_logs if log.error or (log.response_status and log.response_status >= 400)])
            
            durations = [log.duration for log in tab_logs if log.duration]
            avg_duration = sum(durations) / len(durations) if durations else 0

            endpoints = {}
            for log in tab_logs:
                if log.endpoint:
                    endpoints[log.endpoint] = endpoints.get(log.endpoint, 0) + 1

            stats[tab.value] = {
                'tab': tab.value,
                'totalRequests': len(tab_logs),
                'successfulRequests': successful,
                'failedRequests': failed,
                'averageResponseTime': avg_duration,
                'lastRequestTime': max([log.timestamp for log in tab_logs]).isoformat() if tab_logs else None,
                'endpoints': endpoints
            }

        return stats

    @staticmethod
    def get_summary(db: Session) -> dict:
        """Get overall summary"""
        all_logs = db.query(RequestLog).all()
        successful = len([log for log in all_logs if log.response_status and 200 <= log.response_status < 300])
        failed = len([log for log in all_logs if log.error or (log.response_status and log.response_status >= 400)])

        by_tab = {}
        for tab in TabEnum:
            tab_logs = [log for log in all_logs if log.tab == tab]
            tab_successful = len([log for log in tab_logs if log.response_status and 200 <= log.response_status < 300])
            tab_failed = len([log for log in tab_logs if log.error or (log.response_status and log.response_status >= 400)])
            by_tab[tab.value] = {
                'total': len(tab_logs),
                'success': tab_successful,
                'failed': tab_failed
            }

        return {
            'totalRequests': len(all_logs),
            'successfulRequests': successful,
            'failedRequests': failed,
            'byTab': by_tab
        }

    @staticmethod
    def delete_logs(db: Session, tab: Optional[str] = None, older_than_days: Optional[int] = None) -> int:
        """Delete logs - optionally by tab or by age"""
        query = db.query(RequestLog)

        if tab:
            query = query.filter(RequestLog.tab == TabEnum(tab))

        if older_than_days:
            cutoff = datetime.utcnow() - timedelta(days=older_than_days)
            query = query.filter(RequestLog.timestamp < cutoff)

        count = query.delete()
        db.commit()
        return count

    @staticmethod
    def prune_old_logs(db: Session, keep_days: int = 30, max_logs: int = 10000) -> int:
        """Prune old logs to maintain database size"""
        # Delete logs older than keep_days
        cutoff = datetime.utcnow() - timedelta(days=keep_days)
        deleted_old = db.query(RequestLog).filter(RequestLog.timestamp < cutoff).delete()

        # If still over max, delete oldest
        count = db.query(RequestLog).count()
        if count > max_logs:
            excess = count - max_logs
            excess_logs = db.query(RequestLog).order_by(RequestLog.timestamp).limit(excess).all()
            for log in excess_logs:
                db.delete(log)
            db.commit()
            return excess

        db.commit()
        return deleted_old
