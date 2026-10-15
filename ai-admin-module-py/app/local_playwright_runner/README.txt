Automation Studio Local Playwright Runner
=========================================

Requirements already expected on the device:
  - Python 3.10+
  - Node.js and npm
  - @playwright/test in an existing project, or: npm install -g @playwright/test
  - npx playwright install chromium

Adaptive dependency settings (optional):
  - The runner automatically uses installed Chrome, Edge or Brave when found.
  - set AUTOMATION_BROWSER_EXECUTABLE=C:\path\to\chrome.exe overrides detection.
  - set AUTOMATION_FFMPEG_PATH=C:\path\to\ffmpeg.exe lets the runner map one
    FFmpeg binary to whatever revision folder the installed Playwright expects.
  - If FFmpeg is absent, the run continues without video; screenshots and the
    trace remain available.

Python Playwright and Node Playwright are different APIs. Journey/browser
crawls can use the browser collector without Node, but generated TypeScript
specs still require @playwright/test. Pointing at Python's playwright.exe
cannot execute a TypeScript test safely.

Windows: run start-local-runner.bat
Linux/macOS: run sh ./start-local-runner.sh

The runner listens only on 127.0.0.1:8765. Keep it open while using
"Run on this device" in Automation Studio. Each job also requires a one-time,
15-minute token created by an authenticated Studio user.

The same runner handles Knowledge Base device walks and "Rerun on device"
from Automation Studio run history. It accepts one run at a time.

If Playwright is installed in another project (rather than globally), set:
  Windows: set AUTOMATION_PLAYWRIGHT_PROJECT=C:\path\to\playwright-project
  Linux:   export AUTOMATION_PLAYWRIGHT_PROJECT=/path/to/playwright-project
