"""Journey Knowledge Base: the design-side view of an application.

The Automation KB (services/automation/knowledge_base.py) is what the running
application renders -- built by crawling it. The Journey KB is what the
business designed -- built from solution-design documents. They answer
different questions and are kept apart on purpose:

  store.py     loads a Journey KB and turns a matched journey into prompt
               context for test case generation.
  diff.py      compares a test case, step by step, against both KBs and says
               where design and application disagree.
  taxonomy.py  rebuilds taxonomy.json from the transcribed master topic list.
"""
