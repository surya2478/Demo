"""
Fold the separately registered applications into Test Data, with an address per environment.

--- Applications: one registry --------------------------------------------------

Applications used to be registered in three places -- Test Data, Discovery and
the Knowledge Base page -- in two tables that did not know about each other,
each with one address. Test Data is now the one registry, with an address per
environment (automation_data_app_environments, a new table that create_all
builds on start).

The backend does this itself on every start (services/automation/registry.py,
merge_registries), so a deployment needs no manual step. This script runs the
same merge on demand, and with --check reports what it would do without
changing anything:

  * an application with a single address gets it as its default environment's;
  * an application registered only in Discovery or on the Knowledge Base page
    becomes a Test Data application, with that address for its environment;
  * one registered in both gets the Discovery address for that environment
    when it has none of its own there.

Idempotent. Take a copy of the database file first anyway.

    .venv312/Scripts/python.exe add_app_environments.py --check   # report only
    .venv312/Scripts/python.exe add_app_environments.py

In the container (working directory /app, DATABASE_URL at the mounted file):

    docker exec -i <container> python - --check < add_app_environments.py
    docker exec -i <container> python - < add_app_environments.py
"""
import os
import sys

sys.path.insert(0, os.getcwd())


def main() -> int:
    check = "--check" in sys.argv[1:]
    from app.database.connection import Base, SessionLocal, engine
    import app.models.automation  # noqa: F401 - registers the tables
    from app.services.automation.registry import merge_registries

    if not check:
        Base.metadata.create_all(bind=engine)  # the new table, when the backend has not started since
    db = SessionLocal()
    try:
        report = merge_registries(db, apply=not check)
    finally:
        db.close()
    verb = "Would" if check else "Did"
    for key, label in (("addresses_backfilled", "give its single address to its default environment"),
                       ("apps_created", "add to Test Data from Discovery / the Knowledge Base page"),
                       ("addresses_added", "add the Discovery address for")):
        items = report.get(key) or []
        print(f"{verb} {label}: {', '.join(items) if items else 'nothing'}")
    if not any(report.values()):
        print("Nothing to do: every application is already in Test Data with its addresses.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
