"""The step tree -> components: the KB's building blocks, every target resolved.

A Katalon test case is a sequence of called test cases (Common/LaunchUSP,
Common/dashboardMenu, ...). Each top-level call becomes one component; the
steps inside it, including nested calls, become its steps. Values keep where
they come from, as placeholders:

  {column}          a test data column (the sheet's own column name)
  {vault:name}      a secret from the execution profile -- never stored
  {env:name}        a non-secret profile setting (URL, ids)
  {runtime:name}    produced while the test runs (requestId, docId)
  {gen:...}         generated per run (random digits, a date from today)
  {synthetic:kind}  a value the converter masked (<email>, <number>)

Conditions stay attached as data, not code:

  ui        If <object> is visible/present (or not) -- checked at run time
  ui_empty  If <field> is empty -- checked at run time
  data      If <expression over test data> -- decided per data row when a
            test case is built, so the case holds exactly the steps it runs
  runtime   anything else that depends on the running system
  try       steps whose failure is tolerated
"""
from __future__ import annotations

import ast
import copy
import re
from dataclasses import dataclass, field
from typing import Any, Optional

# --- Small helpers ------------------------------------------------------------------

_SECRET = re.compile(r"pass|pwd|secret|token|credit|card|user", re.I)
_TRIVIAL = {"", "YES", "NO", "true", "false", "null", "0", "1", "2"}


def slug(text: str) -> str:
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", text or "")
    text = re.sub(r"[^A-Za-z0-9]+", "_", text).strip("_").lower()
    return re.sub(r"_+", "_", text) or "step"


def parse_label(text: str) -> tuple[str, dict[str, str]]:
    """'star Id (value=loginForm:pwdText)' -> ('star Id', {'value': 'loginForm:pwdText'})."""
    text = text.strip()
    m = re.match(r"^(.*?)\s*\(((?:[^()]|\([^()]*\))*)\)\s*$", text)
    if not m or not m.group(1):
        return text, {}
    label, inner = m.group(1).strip(), m.group(2).strip()
    pos = re.match(r"^\?0=\{'(.*)'\}$", inner)
    if pos:
        return label, {"?0": pos.group(1)}
    if re.match(r"^\w+=", inner):
        params = {}
        for part in re.split(r";\s*(?=\w+=)", inner):
            key, _, value = part.partition("=")
            params[key.strip()] = value.strip()
        return label, params
    return label, {"?0": inner}


def parse_binding(raw: str) -> dict:
    """An input or a typed value as the converter prints it -> what it is."""
    raw = (raw or "").strip()
    m = re.match(r'^"(.*)"\s*\(\{(\w+)\}\)$', raw)
    if m:
        return {"kind": "ref", "name": m.group(2), "literal": m.group(1)}
    m = re.match(r'^"(.*)"$', raw, re.S)
    if m:
        lit = m.group(1)
        if lit in ("<email>", "<number>"):
            return {"kind": "synthetic", "name": lit.strip("<>")}
        return {"kind": "literal", "value": lit}
    m = re.match(r"^\{GlobalVariable\.(\w+)\}$", raw)
    if m:
        return {"kind": "global", "name": m.group(1), "secret": bool(_SECRET.search(m.group(1)))}
    m = re.match(r"^\{secret\}$", raw)
    if m:
        return {"kind": "global", "name": "secret", "secret": True}
    m = re.match(r"^\{(\w+)\}(\s*\(masked test data\))?$", raw)
    if m:
        return {"kind": "ref", "name": m.group(1), "masked": bool(m.group(2))}
    m = re.match(r"^\{'(\d*)'\s*\+\s*CustomKeywords\.'[\w.]*generateRandomNumber'\((\d+)\)\}$", raw)
    if m:
        return {"kind": "gen", "spec": f"digits:{m.group(1)}:{m.group(2)}"}
    m = re.match(r"^\{CustomKeywords\.'[\w.]*currentDate'\((-?\d+)\)\}$", raw)
    if m:
        return {"kind": "gen", "spec": f"date:{int(m.group(1)):+d}"}
    if re.match(r"^-?\d+(\.\d+)?$", raw):
        return {"kind": "literal", "value": raw}
    return {"kind": "expr", "raw": raw}


def placeholder(b: dict) -> str:
    kind = b.get("kind")
    if kind == "data":
        return "{" + b["column"] + "}"
    if kind == "literal":
        return b["value"]
    if kind == "global":
        return ("{vault:" if b.get("secret") else "{env:") + b["name"] + "}"
    if kind == "runtime":
        return "{runtime:" + b["name"] + "}"
    if kind == "gen":
        return "{gen:" + b["spec"] + "}"
    if kind == "synthetic":
        return "{synthetic:" + b["name"] + "}"
    return "{expr:" + b.get("raw", "?") + "}"


# --- Conditions: deciding data conditions per row -------------------------------------

class Undecidable(Exception):
    """The expression needs something only the running system knows."""


def _to_python(expr: str) -> str:
    e = expr.strip()
    e = re.sub(r"(\w+)\.toString\(\)\.toLowerCase\(\)", r"lower(\1)", e)
    e = re.sub(r"(\w+)\.toString\(\)\.contains\(", r"contains(\1, ", e)
    e = re.sub(r"(\w+)\.toString\(\)", r"str(\1)", e)
    e = e.replace("&&", " and ").replace("||", " or ")
    e = re.sub(r"!(?!=)", " not ", e)
    e = re.sub(r"\bnull\b", "None", e)
    e = re.sub(r"\btrue\b", "True", e)
    e = re.sub(r"\bfalse\b", "False", e)
    return e


def evaluate(expr: str, env: dict[str, Any]) -> bool:
    """Groovy-ish boolean over test data. Raises Undecidable for anything else."""
    try:
        tree = ast.parse(_to_python(expr), mode="eval")
    except SyntaxError as exc:
        raise Undecidable(expr) from exc

    def ev(node):
        if isinstance(node, ast.Expression):
            return ev(node.body)
        if isinstance(node, ast.BoolOp):
            vals = [ev(v) for v in node.values]
            return all(vals) if isinstance(node.op, ast.And) else any(vals)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            return not ev(node.operand)
        if isinstance(node, ast.Compare) and len(node.ops) == 1:
            left, right = ev(node.left), ev(node.comparators[0])
            if isinstance(node.ops[0], ast.Eq):
                return _norm(left) == _norm(right)
            if isinstance(node.ops[0], ast.NotEq):
                return _norm(left) != _norm(right)
            raise Undecidable(expr)
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Name):
            if node.id not in env:
                raise Undecidable(node.id)
            value = env[node.id]
            if isinstance(value, str) and value.lower() in ("true", "false"):
                return value.lower() == "true"
            return value
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            args = [ev(a) for a in node.args]
            if node.func.id == "contains" and len(args) == 2:
                return str(args[1]) in str(args[0] or "")
            if node.func.id == "lower" and len(args) == 1:
                return str(args[0] or "").lower()
            if node.func.id == "str" and len(args) == 1:
                return "" if args[0] is None else str(args[0])
        raise Undecidable(expr)

    return bool(ev(tree))


def _norm(value):
    return None if value in ("", None) else value


# --- The model ----------------------------------------------------------------------------

@dataclass
class Context:
    md: dict
    locators: dict[str, dict]                  # object path -> locator entry
    labels: dict[str, list[str]]               # label -> object paths
    keywords: dict[str, dict]                  # "pkg.Class.method" and "method" -> method record
    data_vars: dict[str, dict]                 # converter variable -> {column, example}
    profile_kinds: dict[str, str] = field(default_factory=dict)
    conditions: dict[str, dict] = field(default_factory=dict)
    _cond_seq: int = 0

    def new_cond(self, cond: dict) -> str:
        self._cond_seq += 1
        cid = f"c{self._cond_seq}"
        self.conditions[cid] = {"id": cid, **cond}
        return cid


def _locator_for(ctx: Context, path: Optional[str], label: str, params: dict) -> Optional[dict]:
    if path and path in ctx.locators:
        return ctx.locators[path]
    candidates = ctx.labels.get(label) or []
    if not candidates:
        return None
    if params:
        with_params = [p for p in candidates if ctx.locators[p].get("params")]
        if with_params:
            return ctx.locators[with_params[0]]
    return ctx.locators[candidates[0]]


def _resolve_target(loc: Optional[dict], params: dict[str, str]) -> Optional[str]:
    if not loc or not loc.get("active"):
        return None
    value = loc["active"]["value"]
    names = list(dict.fromkeys(re.findall(r"\$\{(\w+)\}", value)))
    for key, val in params.items():
        name = key if key in names else (names[0] if names and key in ("?0", "_") else key)
        value = value.replace("${" + name + "}", val)
    return value


class Builder:
    """Walks the converter's step tree once and produces components."""

    def __init__(self, ctx: Context):
        self.ctx = ctx
        self.components: list[dict] = []
        self.flow: list[dict] = []
        self.unresolved_objects: dict[str, list[str]] = {}

    # Scopes: a list of {name: binding}; index 0 is the test data.
    def _resolve(self, binding: dict, scopes: list[dict]) -> dict:
        if binding["kind"] != "ref":
            return binding
        name = binding["name"]
        for scope in reversed(scopes):
            if name in scope:
                found = dict(scope[name])
                if binding.get("literal") and not found.get("example"):
                    found["example"] = binding["literal"]
                return found
        return {"kind": "runtime", "name": name, "example": binding.get("literal")}

    def _scope_from_inputs(self, inputs: list[dict], caller: list[dict]) -> dict:
        scope = {}
        for item in inputs:
            b = parse_binding(item["raw"])
            if b["kind"] == "ref":
                resolved = self._resolve(b, caller)
                if b.get("literal") is not None:
                    resolved = {**resolved, "example": b["literal"]}
                scope[item["name"]] = resolved
            else:
                scope[item["name"]] = b
        return scope

    def _template_literal(self, value: str, scopes: list[dict]) -> str:
        """A literal that is really a test data value ('Postpaid') -> its placeholder."""
        if value in _TRIVIAL or len(value) < 3:
            return value
        for scope in reversed(scopes):
            for b in scope.values():
                if b.get("kind") == "data" and b.get("example") == value:
                    return "{" + b["column"] + "}"
        return value

    def _value(self, raw: Optional[str], scopes: list[dict]) -> Optional[dict]:
        if raw is None:
            return None
        b = self._resolve(parse_binding(raw), scopes)
        if b["kind"] == "literal":
            return {**b, "template": self._template_literal(b["value"], scopes)}
        return {**b, "template": placeholder(b)}

    # --- conditions
    def _condition(self, text: str, scopes: list[dict], last_step: Optional[dict]) -> Optional[dict]:
        t = text.strip()
        if not t:
            return None
        if t == "Try":
            return {"kind": "try", "text": "Try (a failure here is tolerated)"}
        if t.startswith("If that fails"):
            return {"kind": "fallback", "text": "If the previous block failed"}
        if t.startswith("Otherwise"):
            return {"kind": "runtime", "text": t, "expr": t}
        if t.startswith("Repeat for"):
            return {"kind": "loop", "text": t}
        m = re.match(r"^If (!\()?(.*?) is (visible|present|still visible after \"(\d+)\".*?s)\)?$", t)
        if m:
            label, params = parse_label(m.group(2))
            params = {k: self._template_literal(v, scopes) for k, v in params.items()}
            loc = _locator_for(self.ctx, None, label, params)
            state = "visible" if m.group(3).startswith(("visible", "still")) else "present"
            return {"kind": "ui", "text": t, "label": label, "params": params, "negate": bool(m.group(1)),
                    "state": state, "object": loc["path"] if loc else None, "target": _resolve_target(loc, params),
                    "after_s": int(m.group(4)) if m.group(4) else None}
        m = re.match(r"^If (!\()?WebUI\.getAttribute\(findTestObject\('(?:Object Repository/)?([^']+)'(?:,\s*\[\('value'\)\s*:\s*'([^']*)'\])?\),\s*'value'\)\.isEmpty\(\)\)?$", t)
        if m:
            params = {"value": self._template_literal(m.group(3), scopes)} if m.group(3) is not None else {}
            loc = self.ctx.locators.get(m.group(2))
            return {"kind": "ui_empty", "text": t, "negate": bool(m.group(1)), "object": m.group(2),
                    "params": params, "target": _resolve_target(loc, params),
                    "label": (loc or {}).get("label") or m.group(2).rsplit("/", 1)[-1]}
        if re.match(r"^If !\(element\.isSelected\(\)\)$", t):
            return {"kind": "ui_not_selected", "text": t, "target": (last_step or {}).get("target"),
                    "label": (last_step or {}).get("label")}
        m = re.match(r"^If (.*)$", t)
        if m:
            expr = m.group(1)
            bare = re.sub(r"\"[^\"]*\"|'[^']*'", "", expr)
            env_names = set(re.findall(r"\b([A-Za-z_]\w*)\b", bare)) - {"null", "true", "false", "toString", "contains", "toLowerCase"}
            bound = {n: self._resolve({"kind": "ref", "name": n}, scopes) for n in env_names}
            decidable = all(b["kind"] in ("data", "literal") for b in bound.values()) and bool(bound)
            return {"kind": "data" if decidable else "runtime", "text": t, "expr": expr,
                    "bindings": {n: b for n, b in bound.items()}}
        return {"kind": "runtime", "text": t, "expr": t}

    # --- steps
    def _action(self, node: dict, scopes: list[dict], comp: dict, conds: list[str], via: Optional[str]) -> Optional[dict]:
        text = node["text"]
        obj = None
        m = re.search(r"\s*\[object:\s*([^\]]+)\]\s*$", text)
        if m:
            obj, text = m.group(1).strip(), text[: m.start()]
        note = None
        m = re.search(r"\s+—\s+\"(.*)\"\s*$", text) or re.search(r"\s+—\s+(.*)$", text)
        if m:
            note, text = m.group(1).strip(), text[: m.start()]
        text = text.strip()

        step: dict[str, Any] = {"source": node["number"], "via": via, "note": note, "object": obj}
        patterns = [
            (r"^Verify (.+?) is displayed$", "assert_visible", ("obj",)),
            (r"^Verify (.+?) is (?:present)$", "assert_present", ("obj",)),
            (r"^Click (.+?), then enter (.+)$", "fill", ("obj", "val")),
            (r"^Type (.+?) into (.+)$", "fill", ("val", "obj")),
            (r"^Enter (.+?) in (.+)$", "fill", ("val", "obj")),
            (r"^Select (.+?) in (.+)$", "select", ("val", "obj")),
            (r"^Clear (.+)$", "clear", ("obj",)),
            (r"^Tick (.+)$", "check", ("obj",)),
            (r"^Scroll to (.+)$", "scroll", ("obj",)),
            (r"^Wait until (.+?) is visible \(up to (\d+) s\)$", "wait_visible", ("obj", "secs")),
            (r"^Wait until (.+?) disappears \(up to (\d+) s\)$", "wait_hidden", ("obj", "secs")),
            (r"^Wait (\d+) seconds?$", "wait", ("secs",)),
            (r"^Switch into the frame:\s*(.+)$", "frame", ("obj",)),
            (r"^Refresh the page$", "reload", ()),
            (r"^Fail the test and stop$", "fail", ()),
            (r"^Press (.+?) on (.+)$", "press", ("key", "obj")),
            (r"^Find Web Element on (.+)$", "manual", ("obj",)),
            (r"^Click (.+)$", "click", ("obj",)),
        ]
        for pattern, kind, roles in patterns:
            m = re.match(pattern, text)
            if not m:
                continue
            step["type"] = kind
            for role, value in zip(roles, m.groups()):
                if role == "obj":
                    label, params = parse_label(value)
                    params = {k: self._template_literal(v, scopes) for k, v in params.items()}
                    loc = _locator_for(self.ctx, obj, label, params)
                    step.update(label=label, params=params, object=obj or (loc or {}).get("path"),
                                target=_resolve_target(loc, params))
                    if step["target"] is None:
                        self.unresolved_objects.setdefault(obj or label, []).append(node["number"] or "")
                elif role == "val":
                    step["value"] = self._value(value, scopes)
                elif role == "secs":
                    step["seconds"] = int(value)
                elif role == "key":
                    step["key"] = re.sub(r"^chord\((\w+)\)$", r"\1", value).title()
            break
        else:
            step.update(type="unparsed", label=text)
        if step["type"] == "fail":
            step["label"] = note or "Stop the test"
        return step

    def _backend_step(self, node: dict, scopes: list[dict], via: Optional[str]) -> dict:
        backend = node["backend"] or {}
        call = node.get("call") or {}
        ref = call.get("ref", "")
        method = self.ctx.keywords.get(ref) or self.ctx.keywords.get(ref.rsplit(".", 1)[-1])
        statements = [{"sql": s, "op": s.split(" ", 1)[0].lower()} for s in backend.get("sql") or []]
        called = []
        for name in backend.get("calls") or []:
            key = re.sub(r"\s+", "", name[:1].lower() + name[1:])
            found = self.ctx.keywords.get(key)
            called.append({"name": name, "method": key if found else None,
                           "reporting": bool(re.search(r"exec\s*record", name, re.I))})
        if method:
            statements = method.get("statements") or statements
        connections = set((method or {}).get("connections") or [])
        for c in called:
            rec = self.ctx.keywords.get(c["method"] or "")
            # Their own result reporting (t_qa_execution_res) is not part of the application check.
            if rec and not c["reporting"]:
                connections |= set(rec.get("connections") or [])
                if not method:
                    statements = statements + [s for s in rec.get("statements") or [] if s not in statements]
        for sub in (method or {}).get("calls") or []:
            rec = self.ctx.keywords.get(f"{method['class']}.{sub}") or self.ctx.keywords.get(sub)
            if rec:
                connections |= set(rec.get("connections") or [])
        mutating_calls = [c for c in called if not c["reporting"] and re.search(
            r"cancel|update|insert|delete|clear|cessation|ws\b|create|reset", c["name"], re.I)]
        writes = any(s["op"] != "select" for s in statements) or bool(mutating_calls)
        inputs = {i["name"]: self._value(i["raw"], scopes[:-1] or scopes) for i in node.get("inputs") or []}
        kind = "db_prep" if writes else "db_check"
        if backend.get("kind") == "driver":
            kind = "navigate"
        return {
            "type": kind, "source": node["number"], "via": via, "label": node["text"],
            "keyword": ref or None, "katalon_kind": call.get("type"),
            "db": {
                "statements": statements, "connections": sorted(connections),
                "calls": called, "inputs": {k: (v or {}).get("template") for k, v in inputs.items()},
                "count_guard_missing": bool((method or {}).get("count_equality_without_zero_guard")) or any(
                    (self.ctx.keywords.get(c["method"] or "") or {}).get("count_equality_without_zero_guard") for c in called),
                "source_known": bool(method) or any(c["method"] for c in called),
            },
        }

    def _walk(self, nodes: list[dict], scopes: list[dict], conds: list[str], comp: dict, via: Optional[str]) -> None:
        last: Optional[dict] = None
        for node in nodes:
            if node["kind"] == "not_run":
                comp["gaps"].append({"expr": node["text"].removeprefix("If ").strip(), "steps_skipped": int(node["number"] or 0),
                                     "conds": list(conds), "bindings": self._condition(node["text"], scopes, None).get("bindings", {})})
                continue
            if node["kind"] == "control":
                cond = self._condition(node["text"], scopes, last)
                if cond is None:
                    self._walk(node["children"], scopes, conds, comp, via)
                    continue
                # "If <loader> is still visible after N s: fail" is a wait for it to go.
                kids = node["children"]
                if cond["kind"] == "ui" and cond.get("after_s") and kids and all(
                        k["kind"] == "step" and k["text"].startswith("Fail the test") for k in kids):
                    note = self._action(kids[0], scopes, comp, conds, via).get("note")
                    self._add(comp, {"type": "wait_hidden", "source": kids[0]["number"], "via": via,
                                     "label": cond["label"], "params": cond["params"], "object": cond["object"],
                                     "target": cond["target"], "seconds": cond["after_s"], "note": note}, conds)
                    continue
                cid = self.ctx.new_cond(cond)
                # A branch filled from another export of this test case: its values are that row's,
                # so its own inputs join the scopes (they map its literals back to test data columns).
                self._walk(kids, scopes + self._graft_scopes(node.get("graft")), conds + [cid], comp, via)
                continue
            # a numbered step
            call = node.get("call")
            if call and call["type"] == "keyword" and call["ref"].endswith("confirmOrderCreated"):
                last = self._add(comp, self._capture_order(node, via), conds)
                continue
            if call and node.get("backend"):
                step = self._backend_step(node, scopes + [self._scope_from_inputs(node.get("inputs") or [], scopes)], via)
                if step["type"] == "navigate":
                    url = next((i["raw"] for i in node.get("inputs") or [] if i["name"] == "url"), None)
                    step = {"type": "navigate", "source": node["number"], "via": via, "label": node["text"],
                            "value": self._value(url, scopes) if url else None}
                last = self._add(comp, step, conds)
                continue
            if call:
                sub_scope = self._scope_from_inputs(node.get("inputs") or [], scopes)
                if node["children"]:
                    self._walk(node["children"], scopes + [sub_scope], conds, comp, call["ref"])
                else:
                    last = self._add(comp, {"type": "call", "source": node["number"], "via": via,
                                            "label": node["text"], "keyword": call["ref"]}, conds)
                continue
            step = self._action(node, scopes, comp, conds, via)
            last = self._add(comp, step, conds)
            if node["children"]:
                self._walk(node["children"], scopes, conds, comp, via)

    def _graft_scopes(self, graft: Optional[dict]) -> list[dict]:
        if not graft:
            return []
        scopes = [{name: {"kind": "data", "column": v["column"],
                          "example": None if "masked" in (v.get("example") or "") else v.get("example")}
                   for name, v in ((d["name"], d) for d in graft.get("data_vars") or [])}]
        for inputs in graft.get("inputs_chain") or []:
            scopes.append(self._scope_from_inputs(inputs, scopes))
        return scopes

    def _capture_order(self, node: dict, via: Optional[str]) -> dict:
        xpaths = [x for item in self.ctx.md.get("inline_locators") or [] if "OrderCreated" in item["file"]
                  for x in item["xpaths"]]
        success = next((x for x in xpaths if "success" in x), "//*[@class = 'text_successfully']/span")
        error = next((x for x in xpaths if "error" in x), "//div[@class='text_error_details']/ul/li")
        timeout = next((int(i["raw"].strip('"')) for i in node.get("inputs") or [] if i["name"] == "p_timeOut"
                        and i["raw"].strip('"').isdigit()), 60)
        return {"type": "capture", "source": node["number"], "via": via, "label": "Order result",
                "keyword": node["call"]["ref"], "target": success, "error_target": error, "seconds": timeout,
                "capture": {"name": "requestId", "pattern": "after '='"},
                "note": "Success shows the Request Id after '='; an error message (with or without a Request Id) fails the test."}

    def _add(self, comp: dict, step: dict, conds: list[str]) -> dict:
        step["conds"] = list(conds)
        step["id"] = f"{comp['id']}.{len(comp['steps']) + 1}"
        step["action"] = describe(step)
        step["expected"] = expected_of(step)
        comp["steps"].append(step)
        return step

    def build(self) -> None:
        root_scope = {name: {"kind": "data", "column": v["column"], "example": v.get("example")}
                      for name, v in self.ctx.data_vars.items()}
        used: dict[str, int] = {}

        def component_from(node: dict, conds: list[str], root: dict) -> None:
            call = node.get("call")
            base = slug(call["ref"].rsplit("/", 1)[-1].rsplit(".", 1)[-1]) if call else slug(node["text"])
            used[base] = used.get(base, 0) + 1
            cid = base if used[base] == 1 else f"{base}_{used[base]}"
            comp = {"id": cid, "name": node["text"], "katalon": call, "source": node["number"],
                    "inputs": [], "steps": [], "gaps": [], "when": list(conds)}
            scope = self._scope_from_inputs(node.get("inputs") or [], [root])
            comp["inputs"] = [{"name": k, "kind": v["kind"], "template": placeholder(v)} for k, v in scope.items()]
            if call and call["type"] == "keyword" and call["ref"].endswith("confirmOrderCreated"):
                self._add(comp, self._capture_order(node, None), [])
            elif call and node.get("backend"):
                step = self._backend_step(node, [root, scope], None)
                if step["type"] == "navigate":
                    url = next((i["raw"] for i in node.get("inputs") or [] if i["name"] == "url"), None)
                    step = {"type": "navigate", "source": node["number"], "label": node["text"],
                            "value": self._value(url, [root]) if url else None}
                self._add(comp, step, [])
            elif call:
                self._walk(node["children"], [root, scope], [], comp, None)
            else:
                self._add(comp, self._action(node, [root], comp, [], None), [])
                if node["children"]:
                    self._walk(node["children"], [root], [], comp, None)
            self.components.append(comp)
            self.flow.append({"component": cid, "when": list(conds)})

        def walk_root(nodes: list[dict], conds: list[str], root: dict) -> None:
            for node in nodes:
                if node["kind"] == "step":
                    component_from(node, conds, root)
                elif node["kind"] == "control":
                    inner = {**root, **self._graft_scopes(node.get("graft"))[0]} if node.get("graft") else root
                    cond = self._condition(node["text"], [root], None)
                    if cond is None:
                        walk_root(node["children"], conds, inner)
                    else:
                        walk_root(node["children"], conds + [self.ctx.new_cond(cond)], inner)
                elif node["kind"] == "not_run" and self.components:
                    self.components[-1]["gaps"].append({"expr": node["text"].removeprefix("If ").strip(),
                                                        "steps_skipped": int(node["number"] or 0), "conds": list(conds),
                                                        "bindings": self._condition(node["text"], [root], None).get("bindings", {})})

        walk_root(self.ctx.md.get("steps") or [], [], root_scope)
        # A component is used once in this flow: it requires the page the previous one left.
        previous = "none"
        for comp in self.components:
            ui = any(s["type"] not in ("db_prep", "db_check", "wait") for s in comp["steps"])
            comp["requires"] = previous if ui else "any"
            comp["leaves"] = f"after_{comp['id']}" if ui else "any"
            if ui:
                previous = comp["leaves"]


# --- Plain-language step text --------------------------------------------------------

def _shown(step: dict) -> str:
    label = step.get("label") or ""
    params = step.get("params") or {}
    value = next(iter(params.values()), None) if params else None
    return f"{label} '{value}'" if value else label


def describe(step: dict) -> str:
    t = step["type"]
    shown = _shown(step)
    value = (step.get("value") or {}).get("template")
    if t == "navigate":
        return f"Open the application at {value or 'its address'}"
    if t == "assert_visible":
        return f"Verify {shown} is displayed"
    if t == "assert_present":
        return f"Verify {shown} is present"
    if t == "fill":
        return f"Enter {value} in {shown}"
    if t == "select":
        return f"Select {value} in {shown}"
    if t == "clear":
        return f"Clear {shown}"
    if t == "check":
        return f"Tick {shown}"
    if t == "scroll":
        return f"Scroll to {shown}"
    if t == "click":
        return f"Click {shown}"
    if t == "wait":
        return f"Wait {step.get('seconds')} seconds"
    if t == "wait_visible":
        return f"Wait up to {step.get('seconds')} s for {shown} to appear"
    if t == "wait_hidden":
        return f"Wait up to {step.get('seconds')} s for {shown} to disappear"
    if t == "frame":
        return f"Switch into the frame {shown}"
    if t == "reload":
        return "Refresh the page"
    if t == "press":
        return f"Press {step.get('key')} on {shown}"
    if t == "fail":
        return f"Stop the test: {step.get('label')}"
    if t == "manual":
        return f"Draw on {shown} (manual: a signature cannot be scripted from the export)"
    if t == "capture":
        return "Read the order result and capture the Request Id"
    if t == "db_prep":
        return f"[Data preparation] {step.get('label')}"
    if t == "db_check":
        return f"[Database check] {step.get('label')}"
    if t == "call":
        return f"Run {step.get('label')} ({step.get('keyword')})"
    return step.get("label") or "Step"


def expected_of(step: dict) -> str:
    t = step["type"]
    shown = _shown(step)
    if t in ("assert_visible", "assert_present"):
        return f"{shown} is displayed"
    if t == "fill":
        return f"{shown} holds the value"
    if t == "select":
        return f"{shown} shows the selected option"
    if t == "check":
        return f"{shown} is ticked"
    if t == "navigate":
        return "The login page loads"
    if t == "wait_hidden":
        return f"{shown} is gone within {step.get('seconds')} s" + (f" (otherwise: {step['note']})" if step.get("note") else "")
    if t == "wait_visible":
        return f"{shown} appears"
    if t == "capture":
        return "A success message with a Request Id is shown"
    if t == "db_check":
        if step.get("db", {}).get("count_guard_missing"):
            return "The request exists (at least one subrequest) and every subrequest is closed (status 90)"
        return "The database shows the expected state"
    if t == "db_prep":
        return "Test data is reset for this run"
    if t == "click":
        return step.get("note") or f"{shown} is clicked"
    return step.get("note") or ""


# --- Putting it together --------------------------------------------------------------

def make_context(md: dict, repository: list[dict], keyword_classes: list[dict], profile: Optional[dict]) -> Context:
    """Locators: the converter's section first, then .rs files (which win: they are the source)."""
    locators: dict[str, dict] = {}
    for item in (md.get("locators") or []) + list(repository or []):
        locators[item["path"]] = {**locators.get(item["path"], {}), **item}
    labels: dict[str, list[str]] = {}
    for path, item in locators.items():
        labels.setdefault(item["label"], []).append(path)
    keywords: dict[str, dict] = {}
    for cls in keyword_classes or []:
        for method in cls["methods"]:
            record = {**method, "class": cls["class"], "file": cls["file"]}
            keywords[f"{cls['class']}.{method['name']}"] = record
            keywords.setdefault(method["name"], record)
    data_vars = {v["name"]: {"column": v["column"], "example": None if "masked" in v["example"] else v["example"]}
                 for v in md.get("data_vars") or []}
    kinds = {v["name"]: v["kind"] for v in (profile or {}).get("variables") or []}
    return Context(md=md, locators=locators, labels=labels, keywords=keywords, data_vars=data_vars, profile_kinds=kinds)


def build_model(ctx: Context) -> dict:
    builder = Builder(ctx)
    builder.build()
    return {"components": builder.components, "flow": builder.flow, "conditions": ctx.conditions,
            "unresolved_objects": builder.unresolved_objects}


# --- Several exports of one test case -------------------------------------------------------
#
# The converter prints a test case for ONE data row: branches that row skips are only
# "(Not run with this test data: If X - n steps skipped)". Another export of the same test
# case, for a row that takes X, has those steps. Merging aligns the two step trees and puts
# the other export's branch where the primary has its "not run" line.

def _flat(text: str) -> str:
    return re.sub(r"\s+", "", text or "")


def _signature(node: dict) -> str:
    if node["kind"] == "step":
        if node.get("call"):
            return "call:" + node["call"]["ref"]
        obj = re.search(r"\[object:\s*([^\]]+)\]", node["text"])
        core = node["text"].split("[object:")[0]
        core = re.sub(r"\s+—.*$", "", core)
        core = re.sub(r"\((?:[^()]|\([^()]*\))*\)|\"[^\"]*\"|\{[^}]*\}", "", core)
        return "step:" + re.sub(r"\s+", " ", core).strip() + "|" + (obj.group(1).strip() if obj else "")
    return node["kind"] + ":" + _flat(re.sub(r"\(value=[^)]*\)", "", node["text"]))


def _count_steps(node: dict) -> int:
    return (1 if node["kind"] == "step" else 0) + sum(_count_steps(c) for c in node.get("children") or [])


def _graft(base: list[dict], other: list[dict], chain: list[list], source: dict, grafted: list[dict]) -> None:
    j = 0
    for i, b in enumerate(base):
        if b["kind"] == "not_run":
            want = _flat(b["text"])
            found = next((o for o in other if o["kind"] == "control" and _flat(o["text"]) == want), None)
            if found:
                new = copy.deepcopy(found)
                new["graft"] = {"file": source.get("file"), "data_key": source.get("data_key"),
                                "data_vars": source.get("data_vars") or [], "inputs_chain": chain}
                base[i] = new
                grafted.append({"expr": b["text"].removeprefix("If ").strip(), "file": source.get("file"),
                                "data_key": source.get("data_key"), "steps": _count_steps(new)})
            continue
        sig = _signature(b)
        k = next((k for k in range(j, len(other)) if _signature(other[k]) == sig), None)
        if k is None:
            continue
        j = k + 1
        o = other[k]
        if b.get("children") and o.get("children"):
            sub_chain = chain + [o.get("inputs") or []] if b["kind"] == "step" and b.get("call") else chain
            _graft(b["children"], o["children"], sub_chain, source, grafted)


def _score(md: dict) -> tuple:
    return (md.get("format") == "v2", len(md.get("locators") or []), sum(_count_steps(n) for n in md.get("steps") or []))


def merge_exports(mds: list[dict]) -> tuple[dict, list[dict]]:
    """Exports of the same Katalon test case -> one md, and what each export contributed."""
    ordered = sorted(mds, key=_score, reverse=True)
    primary = copy.deepcopy(ordered[0])
    report = [{"file": primary.get("file"), "role": "primary", "data_key": primary.get("data_key"), "branches": []}]
    locators = {loc["path"]: loc for loc in primary.get("locators") or []}
    issues = {(i["file"], i["line"]): i for i in primary.get("issues") or []}
    for other in ordered[1:]:
        grafted: list[dict] = []
        _graft(primary["steps"], other.get("steps") or [], [], other, grafted)
        for loc in other.get("locators") or []:
            locators.setdefault(loc["path"], loc)
        for i in other.get("issues") or []:
            issues.setdefault((i["file"], i["line"]), i)
        if not primary.get("inline_locators"):
            primary["inline_locators"] = other.get("inline_locators") or []
        report.append({"file": other.get("file"), "role": "branch_source" if grafted else "superseded",
                       "data_key": other.get("data_key"), "branches": grafted})
    primary["locators"] = list(locators.values())
    primary["issues"] = list(issues.values())
    primary["merged_from"] = report
    return primary, report
