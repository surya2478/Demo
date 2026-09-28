"""
Allow the AI_CHECKS and DRAFT review statuses in a database built before them.

--- Review & Approval: two status values the old CHECK constraints refuse ------

Test Cases now saves a request the moment AI Checks start -- the request as
AI_CHECKS, its cases as DRAFT -- so the session survives a refresh and the page
can find its AI Checks batch again. Both values were added to the CHECK
constraints in app/models/database.py:

    test_case_review_details.overall_status  + 'AI_CHECKS'
    test_cases_details.status                 + 'DRAFT'

`create_all` never alters an existing table, and SQLite cannot change a CHECK
constraint in place. A database whose tables were created from the older model
keeps the old lists, and every AI Checks save then fails with
"CHECK constraint failed". A database whose tables predate the constraints
(no CHECK at all) is unaffected, and so is a fresh one.

So a table is rebuilt only if its stored CREATE statement still has the old
list: a new table is created from that same statement with the value added,
the rows copied across unchanged, the old table dropped, the new one renamed,
and its indexes recreated. One transaction, with foreign-key enforcement off
during the swap; any failure rolls everything back.

Idempotent: a table whose constraint already allows the value, or has no
constraint, is left alone. Take a copy of the database file first anyway.

    .venv312/Scripts/python.exe add_review_draft_status.py --check   # report only
    .venv312/Scripts/python.exe add_review_draft_status.py

In the container (working directory /app, DATABASE_URL at the mounted file):

    docker exec -i <container> python - --check < add_review_draft_status.py
    docker exec -i <container> python - < add_review_draft_status.py
"""
import os
import re
import sqlite3
import sys

# Run as a file or piped over stdin from /app: either way `app` must import.
sys.path.insert(0, os.getcwd())


def _resolve_db_path() -> str:
    """The database the application itself uses, from DATABASE_URL."""
    from app.database.connection import sqlite_file_path

    path = sqlite_file_path()
    if path is None:
        print("DATABASE_URL does not point at a SQLite file. This script writes SQLite-specific DDL.")
        raise SystemExit(2)
    return str(path)


# (table, column, value the constraint must allow)
CHANGES = [
    ("test_case_review_details", "overall_status", "AI_CHECKS"),
    ("test_cases_details", "status", "DRAFT"),
]


def _create_sql(cursor, table: str):
    cursor.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,))
    row = cursor.fetchone()
    return row[0] if row else None


def _needs_value(sql: str, column: str, value: str):
    """The CHECK list for `column`, if there is one and it lacks `value`."""
    match = re.search(rf"\b{column}\s+IN\s*\(([^)]*)\)", sql, flags=re.IGNORECASE)
    if not match or f"'{value}'" in match.group(1):
        return None
    return match


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    check_only = "--check" in argv
    db_path = _resolve_db_path()
    if not os.path.exists(db_path):
        print(f"No database at {db_path}. Start the app once so create_all builds it.")
        return 1

    print(f"Database: {db_path}")
    conn = sqlite3.connect(db_path, isolation_level=None)
    cursor = conn.cursor()
    todo = []
    for table, column, value in CHANGES:
        sql = _create_sql(cursor, table)
        if sql is None:
            print(f"  = {table}: not created yet -- create_all builds it with the new constraint")
            continue
        match = _needs_value(sql, column, value)
        if match is None:
            print(f"  = {table}.{column}: already accepts '{value}' (or has no CHECK)")
            continue
        print(f"  ! {table}.{column}: CHECK refuses '{value}' -- table needs rebuilding")
        todo.append((table, sql, match, value))

    if not todo:
        print("\nNothing to do.")
        conn.close()
        return 0
    if check_only:
        print(f"\n{len(todo)} table(s) need rebuilding. Run again without --check.")
        conn.close()
        return 3

    cursor.execute("PRAGMA foreign_keys=OFF")
    try:
        cursor.execute("BEGIN")
        for table, sql, match, value in todo:
            count = cursor.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            indexes = [
                row[0]
                for row in cursor.execute(
                    "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL", (table,)
                )
            ]
            new_list = f"'{value}', " + match.group(1).strip()
            new_sql = sql[: match.start(1)] + new_list + sql[match.end(1):]
            temp = f"{table}__new"
            new_sql = re.sub(rf'^CREATE TABLE\s+"?{table}"?', f'CREATE TABLE "{temp}"', new_sql, count=1)
            cursor.execute(new_sql)
            cursor.execute(f'INSERT INTO "{temp}" SELECT * FROM "{table}"')
            cursor.execute(f'DROP TABLE "{table}"')
            cursor.execute(f'ALTER TABLE "{temp}" RENAME TO "{table}"')
            for index_sql in indexes:
                cursor.execute(index_sql)
            copied = cursor.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            if copied != count:
                raise sqlite3.Error(f"{table}: {count} rows before, {copied} after")
            print(f"  + {table}: rebuilt, {copied} row(s) kept, {len(indexes)} index(es) recreated")
        cursor.execute("COMMIT")
    except sqlite3.Error as exc:
        cursor.execute("ROLLBACK")
        print(f"FAILED, rolled back -- the database is unchanged: {exc}")
        return 1
    finally:
        cursor.execute("PRAGMA foreign_keys=ON")
        conn.close()

    print("\nDone.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
