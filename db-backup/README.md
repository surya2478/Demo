# db-backup

This directory is the backend's database volume. `docker-compose.yml` bind-mounts
it as `/app/external-db`, and `DATABASE_URL` points at `admin.db` inside it.

**This README is what keeps the directory in Git.** Nothing else here is tracked
— `admin.db` and its `-wal`/`-shm` sidecars are ignored, because a committed
database is a committed credential list. Git does not store empty directories,
so without a tracked file here a fresh clone would not create `db-backup/` at
all, Docker would create it as **root**, and the container — which runs as uid
10001 — could not write the database. That fails at startup and reaches a
browser as **502 Bad Gateway** from nginx.

## First deployment on a new host

The directory needs to be writable by the container's uid before the first
`up`:

```bash
mkdir -p db-backup
sudo chown -R 10001:10001 db-backup
```

There is no need to supply a database. SQLite creates the file, `init_db`
creates the tables, and `app/seed.py` seeds the starting accounts
(`admin`, `qa_user`, `manager`, `tester`).

## Existing deployments

The `admin.db` here is live data and belongs to the server that runs it. Back it
up on that host — not by committing it.
