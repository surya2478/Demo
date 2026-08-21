"""add_timeslot_columns

Revision ID: 20260130_add_timeslot_columns
Revises: 20260122_add_auth_source_to_users
Create Date: 2026-01-30

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '20260130_add_timeslot_columns'
down_revision = '20260122_add_auth_source_to_users'
branch_labels = None
depends_on = None


def upgrade():
    """Add allowed_time_start and allowed_time_end columns to users table"""
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.add_column(sa.Column('allowed_time_start', sa.String(), nullable=True))
        batch_op.add_column(sa.Column('allowed_time_end', sa.String(), nullable=True))


def downgrade():
    """Remove allowed_time_start and allowed_time_end columns from users table"""
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_column('allowed_time_end')
        batch_op.drop_column('allowed_time_start')
