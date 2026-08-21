-- Add token_allocation column to users table
-- This script adds a token_allocation column with default value of 10,000 tokens

-- Step 1: Add the column (allows NULL initially for SQLite compatibility)
ALTER TABLE users ADD COLUMN token_allocation INTEGER DEFAULT 10000;

-- Step 2: Update any existing NULL values to the default
UPDATE users SET token_allocation = 10000 WHERE token_allocation IS NULL;

-- Verification query to check the column was added successfully
SELECT username, email, role, token_allocation FROM users LIMIT 5;
