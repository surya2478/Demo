"""Generation services for the Test Assistant tabs.

Streaming LLM calls that render progressively in the browser, as opposed to
services/automation/, which buffers a whole reply and validates it against a
schema. Different failure modes, different transport -- see stream.py.
"""
