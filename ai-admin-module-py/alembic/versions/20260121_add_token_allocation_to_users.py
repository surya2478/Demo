"""add token_allocation to users

Revision ID: 20260121_token_allocation
Revises: 
Create Date: 2026-01-21

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '20260121_token_allocation'
down_revision = None  # Update this to the previous migration if one exists
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add token_allocation column to users table"""
    # Add the column with a default value of 10000
    op.add_column('users', sa.Column('token_allocation', sa.Integer(), nullable=True, server_default='10000'))
    
    # Update existing rows to have the default value
    op.execute('UPDATE users SET token_allocation = 10000 WHERE token_allocation IS NULL')
    
    # Make the column non-nullable after setting default values
    with op.batch_alter_table('users') as batch_op:
        batch_op.alter_column('token_allocation', nullable=False)


def downgrade() -> None:
    """Remove token_allocation column from users table"""
    op.drop_column('users', 'token_allocation')
