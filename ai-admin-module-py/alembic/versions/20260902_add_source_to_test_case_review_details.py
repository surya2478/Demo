"""add_source_to_test_case_review_details

Revision ID: 20260902_add_review_source
Revises: 20260821_add_document_id
Create Date: 2026-09-02

"""
from alembic import op
import sqlalchemy as sa


revision = '20260902_add_review_source'
down_revision = '20260821_add_document_id'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('test_case_review_details', schema=None) as batch_op:
        batch_op.add_column(sa.Column('source', sa.String(length=64), nullable=True))
        batch_op.create_index('ix_test_case_review_details_source', ['source'], unique=False)


def downgrade():
    with op.batch_alter_table('test_case_review_details', schema=None) as batch_op:
        batch_op.drop_index('ix_test_case_review_details_source')
        batch_op.drop_column('source')