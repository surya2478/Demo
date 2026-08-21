"""Add token tracking columns to request_logs table

Revision ID: 001
Revises: 
Create Date: 2026-01-13 12:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '001'
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add token columns to request_logs table"""
    # Add prompt_tokens column
    op.add_column('request_logs', sa.Column('prompt_tokens', sa.Integer(), nullable=True))
    
    # Add response_tokens column
    op.add_column('request_logs', sa.Column('response_tokens', sa.Integer(), nullable=True))
    
    # Add total_tokens column
    op.add_column('request_logs', sa.Column('total_tokens', sa.Integer(), nullable=True))


def downgrade() -> None:
    """Remove token columns from request_logs table"""
    op.drop_column('request_logs', 'total_tokens')
    op.drop_column('request_logs', 'response_tokens')
    op.drop_column('request_logs', 'prompt_tokens')
