"""
Guided Flow Discovery Service.

Enables interactive headed browser recording of page objects for a specific test case.
Captures high-fidelity DOM element locators, action intents, and context.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional

from sqlalchemy.orm import Session

from ...database.connection import SessionLocal
from ...models.automation import AutomationTestCase

logger = logging.getLogger(__name__)

# Script injected into all pages during guided discovery
GUIDED_DISCOVERY_INJECTED_SCRIPT = r"""
(function() {
  if (window.__agy_guided_discovery_installed) return;
  window.__agy_guided_discovery_installed = true;

  // Restore history from sessionStorage across page transitions
  let savedHistory = [];
  try {
    savedHistory = JSON.parse(sessionStorage.getItem('__agy_discovery_history') || '[]');
  } catch(e) { savedHistory = []; }

  let stepCount = savedHistory.length;
  let lastActionDesc = stepCount > 0 ? `Step ${stepCount} recorded` : 'Click or type on the page to record objects...';

  function saveEvent(evt) {
    savedHistory.push(evt);
    try {
      sessionStorage.setItem('__agy_discovery_history', JSON.stringify(savedHistory));
    } catch(e) {}
    if (window.__onGuidedDiscoveryEvent) {
      try {
        window.__onGuidedDiscoveryEvent(evt);
      } catch(e) {}
    }
  }

  // Inject UI HUD
  function injectHUD() {
    if (document.getElementById('agy-guided-discovery-hud')) return;
    const hud = document.createElement('div');
    hud.id = 'agy-guided-discovery-hud';
    hud.style.cssText = `
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 2147483647;
      background: rgba(15, 23, 42, 0.94);
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 12px 16px;
      border-radius: 14px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.1);
      width: 290px;
      font-size: 12px;
      backdrop-filter: blur(12px);
      user-select: none;
      transition: all 0.2s ease;
    `;

    hud.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 6px;">
        <div style="display: flex; align-items: center; gap: 6px; font-weight: 700; color: #38bdf8;">
          <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #ef4444; animation: agy-pulse 1.5s infinite;"></span>
          Guided Discovery
        </div>
        <span id="agy-step-counter" style="background: rgba(56, 189, 248, 0.15); color: #38bdf8; font-weight: 600; padding: 2px 8px; border-radius: 99px; font-size: 11px;">${stepCount} steps</span>
      </div>
      <div id="agy-last-action" style="color: #94a3b8; font-size: 11px; margin-bottom: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
        ${lastActionDesc}
      </div>
      <div style="display: flex; gap: 8px;">
        <button id="agy-finish-btn" style="flex: 1; background: linear-gradient(135deg, #10b981, #059669); color: white; border: none; padding: 6px 12px; border-radius: 8px; font-weight: 600; font-size: 11px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 4px; box-shadow: 0 2px 8px rgba(16,185,129,0.3);">
          ✓ Finish & Save
        </button>
        <button id="agy-cancel-btn" style="background: rgba(255,255,255,0.1); color: #cbd5e1; border: none; padding: 6px 10px; border-radius: 8px; font-size: 11px; cursor: pointer;">
          ✕
        </button>
      </div>
      <style>
        @keyframes agy-pulse {
          0% { transform: scale(0.95); opacity: 0.8; }
          50% { transform: scale(1.2); opacity: 1; }
          100% { transform: scale(0.95); opacity: 0.8; }
        }
        .agy-highlight-flash {
          outline: 2px solid #10b981 !important;
          outline-offset: 2px !important;
          transition: outline 0.3s ease !important;
        }
      </style>
    `;

    document.documentElement.appendChild(hud);

    document.getElementById('agy-finish-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (window.__onGuidedDiscoveryFinish) {
        window.__onGuidedDiscoveryFinish(savedHistory);
      }
    });

    document.getElementById('agy-cancel-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      hud.remove();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectHUD);
  } else {
    injectHUD();
  }

  setInterval(() => {
    if (!document.getElementById('agy-guided-discovery-hud')) {
      injectHUD();
    }
  }, 1000);

  // Element locator extraction logic
  function extractElementInfo(el) {
    if (!el || el === document.body || el === document.documentElement) return null;
    const tag = el.tagName.toLowerCase();
    const id = el.id || '';
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-qa') || '';
    const ariaLabel = el.getAttribute('aria-label') || '';
    const placeholder = el.getAttribute('placeholder') || '';
    const name = el.getAttribute('name') || '';
    const role = el.getAttribute('role') || getImplicitRole(el);
    const innerText = (el.innerText || el.textContent || '').trim().slice(0, 80);
    const accessibleName = ariaLabel || placeholder || innerText || el.getAttribute('title') || el.getAttribute('alt') || id || name;

    const alternatives = [];
    let recommended = '';

    if (testId) {
      recommended = `page.getByTestId('${testId}')`;
      alternatives.push(recommended);
    }

    if (role && accessibleName && accessibleName.length < 50) {
      const roleLoc = `page.getByRole('${role}', { name: '${accessibleName.replace(/'/g, "\\'")}' })`;
      if (!recommended) recommended = roleLoc;
      alternatives.push(roleLoc);
    }

    if (placeholder) {
      const plLoc = `page.getByPlaceholder('${placeholder.replace(/'/g, "\\'")}')`;
      if (!recommended) recommended = plLoc;
      alternatives.push(plLoc);
    }

    if (ariaLabel) {
      const labelLoc = `page.getByLabel('${ariaLabel.replace(/'/g, "\\'")}')`;
      if (!recommended) recommended = labelLoc;
      alternatives.push(labelLoc);
    }

    if (innerText && innerText.length > 1 && innerText.length < 40) {
      const textLoc = `page.getByText('${innerText.replace(/'/g, "\\'")}')`;
      if (!recommended) recommended = textLoc;
      alternatives.push(textLoc);
    }

    if (id && !id.match(/\d{4,}/)) {
      const idLoc = `page.locator('#${id}')`;
      if (!recommended) recommended = idLoc;
      alternatives.push(idLoc);
    }

    if (!recommended) {
      const cleanText = accessibleName.replace(/[^a-zA-Z0-9\s]/g, '').trim();
      recommended = `page.locator('${tag}').filter({ hasText: /${cleanText || tag}/i }).first()`;
      alternatives.push(recommended);
    }

    return {
      tag,
      id,
      test_id: testId,
      role,
      accessible_name: accessibleName,
      inner_text: innerText,
      recommended_locator: recommended,
      alternative_locators: Array.from(new Set(alternatives)),
      page_url: window.location.href,
    };
  }

  function getImplicitRole(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.href) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      if (['button', 'submit', 'reset'].includes(type)) return 'button';
      if (['checkbox', 'radio'].includes(type)) return type;
      return 'textbox';
    }
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') return 'heading';
    return '';
  }

  function flashElement(el) {
    el.classList.add('agy-highlight-flash');
    setTimeout(() => el.classList.remove('agy-highlight-flash'), 800);
  }

  let lastCapturedTarget = null;
  let lastCapturedTime = 0;

  function handleInteraction(el, actionType, extraVal) {
    if (!el || el === document.body || el === document.documentElement) return;
    const hud = document.getElementById('agy-guided-discovery-hud');
    if (hud && hud.contains(el)) return;

    const targetEl = el.closest('a, button, input, select, textarea, [role="button"], [role="tab"], [role="menuitem"], [role="link"], label') || el;
    const info = extractElementInfo(targetEl);
    if (!info) return;

    const now = Date.now();
    if (lastCapturedTarget === targetEl && (now - lastCapturedTime < 400)) {
      return;
    }
    lastCapturedTarget = targetEl;
    lastCapturedTime = now;

    stepCount++;
    flashElement(targetEl);

    const desc = actionType === 'fill' ? `Filled "${extraVal || ''}" in ${info.accessible_name || info.tag}` : `Clicked "${info.accessible_name || info.tag}"`;
    const counterEl = document.getElementById('agy-step-counter');
    if (counterEl) counterEl.textContent = `${stepCount} steps`;
    const actionEl = document.getElementById('agy-last-action');
    if (actionEl) actionEl.textContent = desc;

    saveEvent({
      step_number: stepCount,
      action: actionType,
      value: extraVal || null,
      target_name: info.accessible_name || info.tag,
      recommended_locator: info.recommended_locator,
      alternative_locators: info.alternative_locators,
      page_url: info.page_url,
      tag_name: info.tag,
      role: info.role,
      accessible_name: info.accessible_name,
      timestamp: new Date().toISOString()
    });
  }

  document.addEventListener('pointerdown', (e) => handleInteraction(e.target, 'click'), { capture: true, passive: true });
  document.addEventListener('change', (e) => handleInteraction(e.target, e.target.tagName.toLowerCase() === 'select' ? 'select' : 'fill', e.target.value), { capture: true, passive: true });
})();
"""


@dataclass
class GuidedDiscoverySession:
    test_case_id: int
    display_id: str
    target_url: str
    status: str = "starting"  # starting | recording | completed | stopped | error
    captured_objects: list[dict[str, Any]] = field(default_factory=list)
    error: Optional[str] = None
    started_at: datetime = field(default_factory=datetime.utcnow)
    _stop_requested: bool = False
    _thread: Optional[threading.Thread] = None


class GuidedDiscoveryManager:
    """Manages active live browser guided discovery sessions."""

    def __init__(self):
        self._sessions: dict[int, GuidedDiscoverySession] = {}
        self._lock = threading.Lock()

    def get_session(self, test_case_id: int) -> Optional[GuidedDiscoverySession]:
        with self._lock:
            s = self._sessions.get(test_case_id)
            if s:
                if s._thread and not s._thread.is_alive() and s.status in ("starting", "recording"):
                    s.status = "completed"
            return s

    def start_session(self, case: AutomationTestCase) -> GuidedDiscoverySession:
        with self._lock:
            existing = self._sessions.get(case.id)
            if existing:
                existing._stop_requested = True

            url = (case.application_url or "https://www.eand.ae/en/index.html").strip()
            session = GuidedDiscoverySession(
                test_case_id=case.id,
                display_id=case.display_id,
                target_url=url,
                status="starting",
                captured_objects=[],
            )
            self._sessions[case.id] = session

        # Start native Google Chrome directly via dedicated daemon thread
        thread = threading.Thread(
            target=self._run_browser_session,
            args=(session,),
            daemon=True,
            name=f"guided-discovery-tc-{case.id}",
        )
        session._thread = thread
        thread.start()
        return session

    def stop_session(self, test_case_id: int) -> Optional[GuidedDiscoverySession]:
        with self._lock:
            session = self._sessions.get(test_case_id)
            if not session:
                return None
            session._stop_requested = True
            self._persist_captured_objects(session)
            if session._thread and session._thread.is_alive() and threading.current_thread() != session._thread:
                session._thread.join(timeout=2.0)
            return session

    def _persist_captured_objects(self, session: GuidedDiscoverySession):
        """Saves captured page objects to the database for this test case."""
        db: Session = SessionLocal()
        try:
            case = db.query(AutomationTestCase).filter(AutomationTestCase.id == session.test_case_id).first()
            if case:
                case.recorded_flow_objects = list(session.captured_objects)
                case.flow_discovery_status = "captured" if session.captured_objects else "none"
                # Also update twin test cases with matching display_id
                twins = db.query(AutomationTestCase).filter(
                    AutomationTestCase.display_id == case.display_id,
                    AutomationTestCase.id != case.id,
                ).all()
                for tw in twins:
                    tw.recorded_flow_objects = list(session.captured_objects)
                    tw.flow_discovery_status = "captured" if session.captured_objects else "none"
                db.commit()
                logger.info(
                    "Successfully persisted %d flow objects for TC ID %s (%s)",
                    len(session.captured_objects),
                    case.id,
                    case.display_id,
                )
        except Exception as exc:
            logger.error("Failed to persist recorded flow objects for TC ID %s: %s", session.test_case_id, exc)
        finally:
            db.close()

    def _run_browser_session(self, session: GuidedDiscoverySession):
        from playwright.sync_api import sync_playwright

        logger.info("Starting Guided Discovery browser for TC %s at %s", session.display_id, session.target_url)
        try:
            with sync_playwright() as p:
                launch_kwargs = {
                    "headless": False,
                    "args": [
                        "--disable-blink-features=AutomationControlled",
                        "--no-sandbox",
                        "--disable-infobars",
                        "--start-maximized",
                    ],
                    "ignore_default_args": ["--enable-automation"],
                }
                browser = None
                try:
                    browser = p.chromium.launch(channel="chrome", **launch_kwargs)
                except Exception as e:
                    logger.warning("Could not launch channel=chrome, fallback to default chromium: %s", e)
                    browser = p.chromium.launch(**launch_kwargs)

                context = browser.new_context(
                    viewport={"width": 1920, "height": 1080},
                    user_agent=(
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/126.0.0.0 Safari/537.36"
                    ),
                )
                context.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined});")

                # Expose bindings before navigating
                def handle_event(source, event_data):
                    logger.info("Captured DOM element: %s (%s)", event_data.get("target_name"), event_data.get("action"))
                    session.captured_objects.append(event_data)
                    self._persist_captured_objects(session)

                def handle_finish(source, client_history=None):
                    logger.info("User clicked Finish & Save on HUD for TC %s", session.display_id)
                    if client_history and isinstance(client_history, list) and len(client_history) > len(session.captured_objects):
                        session.captured_objects = client_history
                    session._stop_requested = True

                context.expose_binding("__onGuidedDiscoveryEvent", handle_event)
                context.expose_binding("__onGuidedDiscoveryFinish", handle_finish)
                context.add_init_script(GUIDED_DISCOVERY_INJECTED_SCRIPT)

                page = context.new_page()
                try:
                    page.goto(session.target_url, wait_until="domcontentloaded", timeout=45000)
                except Exception as nav_err:
                    logger.warning("Page navigation warning for %s: %s", session.target_url, nav_err)

                session.status = "recording"

                # Wait loop until user finishes or closes browser
                while not session._stop_requested:
                    try:
                        if page.is_closed() or not browser.is_connected():
                            break
                        time.sleep(0.5)
                    except Exception:
                        break

                session.status = "completed"
                self._persist_captured_objects(session)
                try:
                    browser.close()
                except Exception:
                    pass

        except Exception as exc:
            logger.error("Guided Discovery session error for TC %s: %s", session.display_id, exc)
            session.status = "error"
            session.error = str(exc)


guided_discovery_manager = GuidedDiscoveryManager()
