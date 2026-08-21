"""Add auth_source column to users table

Revision ID: 20260122_auth_source
Revises: 20260121_add_token_allocation_to_users
Create Date: 2026-01-22

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '20260122_auth_source'
down_revision = '20260121_add_token_allocation_to_users'
branch_labels = None
depends_on = None


def upgrade():
    """Add auth_source column with default 'local' for existing users"""
    # Add auth_source column
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.add_column(sa.Column('auth_source', sa.String(), nullable=True))
    
    # Set default value for existing rows (all existing users are 'local')
    op.execute("UPDATE users SET auth_source = 'local' WHERE auth_source IS NULL")
    
    # Make column non-nullable after setting defaults
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.alter_column('auth_source', nullable=False)
    
    print("✅ Added auth_source column to users table (default: 'local')")


def downgrade():
    """Remove auth_source column"""
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_column('auth_source')
    
    print("✅ Removed auth_source column from users table")
