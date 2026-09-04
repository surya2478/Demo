"""ADO-facing BRD ingestion API.

Accepts one BRD document, generates test cases using the same implementation as
``POST /generate/brd-testcases``, and stores them as an ADO review request.
"""
from __future__ import annotations

import uuid
import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session
import httpx

from ..config import AiConfigModel, settings
from ..database.connection import get_db
from ..services.automation import extraction
from ..utils.security import get_current_user_strict
from .test_case_reviews import create_review_submission

router = APIRouter()
_AI_CONFIG_PATH = Path(__file__).resolve().parent.parent / 'config.json'

# Helper function to generate the test cases URL and AI configuration
def _generate_test_cases_url() -> tuple[str, AiConfigModel]:
    """Resolve the same BASE_URL + endpoint pair the frontend uses."""
    config = settings.ai_config
    if _AI_CONFIG_PATH.exists():
        try:
            config = AiConfigModel.model_validate(json.loads(_AI_CONFIG_PATH.read_text(encoding='utf-8')))
        except (OSError, ValueError) as exc:
            raise HTTPException(status_code=500, detail=f'Unable to read AI configuration: {exc}') from exc

    base_url = (config.BASE_URL or '').strip().rstrip('/')
    endpoint = (config.ENDPOINTS.generateTestCases or '').strip()
    if not base_url or not endpoint:
        raise HTTPException(status_code=500, detail='BASE_URL or ENDPOINTS.generateTestCases is not configured')
    return f"{base_url}/{endpoint.lstrip('/')}" , config

# Helper function to resolve the TLS trust setting for the AI service call
def _ai_service_ssl_verify() -> Any:
    if not settings.AI_SERVICE_VERIFY_SSL:
        return False

    ca_bundle = (settings.AI_SERVICE_CA_BUNDLE_PATH or '').strip()
    if not ca_bundle:
        return True
    if not Path(ca_bundle).is_file():
        raise HTTPException(
            status_code=500,
            detail=f'AI_SERVICE_CA_BUNDLE_PATH does not point to a readable file: {ca_bundle}',
        )
    return ca_bundle

# Helper function to extract table rows from generated test-case content
def _table_rows(generated_text: str) -> list[dict[str, str]]:
    """Extract the first Markdown table from generated test-case content."""
    lines = [line.strip() for line in (generated_text or '').replace('\r', '').split('\n')]
    table_lines = [line for line in lines if '|' in line]
    if len(table_lines) < 3:
        return []

    rows = [[cell.strip() for cell in line.strip().strip('|').split('|')] for line in table_lines]
    headers = rows[0]
    if not headers:
        return []

    records: list[dict[str, str]] = []
    for cells in rows[1:]:
        if not any(cells) or all(set(cell) <= {'-', ':'} for cell in cells if cell):
            continue
        record = {header: cells[index] if index < len(cells) else '' for index, header in enumerate(headers)}
        if any(value for value in record.values()):
            records.append(record)
    return records

# Endpoint to submit a BRD for review
@router.post('/brd-to-review')
async def submit_ado_brd_for_review(
    brd_file: UploadFile = File(...),
    document_id: str = Form(default=''),
    temperature: float = Form(default=0.2),
    max_tokens: int = Form(default=4096),
    current_user: dict = Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    """Generate table-form test cases from a BRD and submit them for review."""
    filename = brd_file.filename or 'ado-brd.txt'
    file_type = extraction.type_for_filename(filename)
    if file_type is None:
        raise HTTPException(status_code=422, detail='Unsupported BRD file type')

    contents = await brd_file.read()
    try:
        extraction.validate_signature(file_type, contents[:8])
        brd_text, _ = extraction.extract_text(contents, file_type)
    except extraction.ExtractionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    if not brd_text:
        raise HTTPException(status_code=422, detail='The BRD did not contain readable text')

    # Generate URL and AI configuration for test-case generation
    generate_url, ai_config = _generate_test_cases_url()
    print(f'Generating test cases using URL: {generate_url} and AI config: {ai_config}')

    # Call the AI service (LLM) to generate test cases from the BRD text
    request_headers = {'Accept':'text/plain'}
    ai_service_token = (settings.AI_SERVICE_AUTH_TOKEN or '').strip()
    if ai_service_token:
        request_headers['Authorization'] = f'Bearer {ai_service_token}'

    try:
        async with httpx.AsyncClient(
            timeout=settings.AI_SERVICE_TIMEOUT_SECONDS,
            verify=_ai_service_ssl_verify(),
        ) as client:
            response = await client.post(
                generate_url,
                data={
                    'text': brd_text,
                    'provider': ai_config.PARAMETERS.provider,
                    'model_name': ai_config.PARAMETERS.model,
                    'temperature': str(temperature),
                    'max_tokens': str(max_tokens),
                    'response_format': 'text',
                },
                # headers={'Accept': 'text/plain'},
                headers = request_headers,
            )
            response.raise_for_status()
            generated_text = response.text
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f'BRD test-case generation failed: {exc}') from exc
    print(f'Generated text: {generated_text}')
    rows = _table_rows(generated_text)
    if not rows:
        raise HTTPException(status_code=502, detail='The generator response did not contain a test-case table')

    print(f'Parsed table rows: {rows}')

    # Prepare the payload for creating a review submission
    request_id = f'ADO-REQ-{uuid.uuid4().hex[:12].upper()}'
    username = current_user.get('username') or current_user.get('sub') or 'system'
    resolved_document_id = document_id.strip() or filename
    payload: dict[str, Any] = {
        'request_id': request_id,
        'source': 'AZURE_DEVOPS',
        'request_by': username,
        'document_id': resolved_document_id,
        'brd_document': [{'id': f'ado-{request_id}', 'name': filename, 'content': brd_text, 'type': 'file'}],
        'rows': [
            {
                'test_case_id': f'{request_id}-TC-{index + 1}',
                'request_id': request_id,
                'test_case_details': row,
                'status': 'PENDING',
                'generated_by': username,
            }
            for index, row in enumerate(rows)
        ],
        'payload': {
            'inputType': 'ado-brd',
            'source': brd_text,
            'generated': generated_text,
        },
    }
    # Create the review submission using the prepared payload
    result = create_review_submission(payload, current_user, db)
    return {**result, 'generated_test_cases': len(rows)}