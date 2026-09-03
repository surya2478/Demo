"""add_document_id_to_test_cases_details

Revision ID: 20260821_add_document_id
Revises: 20260130_add_timeslot_columns
Create Date: 2026-08-21

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '20260821_add_document_id'
down_revision = '20260130_add_timeslot_columns'
branch_labels = None
depends_on = None


def upgrade():
    """Add document_id column to test_cases_details table"""
    with op.batch_alter_table('test_cases_details', schema=None) as batch_op:
        batch_op.add_column(sa.Column('document_id', sa.String(length=255), nullable=True))
        batch_op.create_index('ix_test_cases_details_document_id', ['document_id'], unique=False)


def downgrade():
    """Remove document_id column from test_cases_details table"""
    with op.batch_alter_table('test_cases_details', schema=None) as batch_op:
        batch_op.drop_index('ix_test_cases_details_document_id')
        batch_op.drop_column('document_id')
