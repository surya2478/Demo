"""
--- Katalon Import: a QA team's Katalon project -> Automation KB -> test cases -> scripts --

The QA team's Katalon tests are the ground truth for applications we cannot
crawl from here (USP/CIM sits inside the enterprise network). This package
reads what the team exports and turns it into the three things the platform
needs, all from ONE set of step records so they never drift apart:

  inputs     intake.py   uploads, nested zips, file recognition, storage
  reading    parse.py    converter Markdown, Object Repository .rs, test data
                         (.dat/.csv/.xlsx), execution profile .glbl (secrets
                         are dropped on read), keyword .groovy
  model      model.py    the step tree -> components with resolved locators,
                         frames, data/UI conditions, backend (DB) steps
  findings   analysis.py what is present, missing, fragile or wrong
  outputs    generate.py per data row: manual test case + Playwright and
                         Katalon scripts from the same built steps, and a
                         conformance check that they match step for step
  publish    publish.py  KB bundle files, a draft Automation KB change set
                         (approved on the Knowledge Base page), downloads

Nothing here calls a model: every output is derived from the uploads.
"""
