import pytest
from app.models.database import TestCaseReview, TestCaseReviewDetail, TestCaseDetail


def test_review_model_has_required_fields():
    fields = {column.name for column in TestCaseReview.__table__.columns}
    required = {
        'id',
        'submitted_by',
        'status',
        'payload',
        'documents',
        'created_at',
        'updated_at'
    }
    assert required.issubset(fields)


def test_review_detail_models_have_requested_schema():
    detail_fields = {column.name for column in TestCaseReviewDetail.__table__.columns}
    case_fields = {column.name for column in TestCaseDetail.__table__.columns}

    assert {'request_id', 'request_by', 'request_date_time', 'brd_document', 'no_of_test_cases', 'approved_count', 'rejected_count', 'overall_status', 'review_notes', 'reviewed_by', 'reviewed_date_time'}.issubset(detail_fields)
    assert {'test_case_id', 'request_id', 'test_case_details', 'status', 'rejection_reason', 'reviewed_by', 'reviewed_datetime', 'generated_by'}.issubset(case_fields)
