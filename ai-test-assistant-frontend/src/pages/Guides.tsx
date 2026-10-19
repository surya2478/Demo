import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { usePageHeader } from '../components/layout/PageHeaderContext'
import automationService from '../services/automationService'
import { getLocalRunnerStatus, type LocalRunnerStatus } from '../services/localRunner'
import { COLLECTOR_VERSION, installedCollectorVersion } from '../services/browserCollector'

const CARD = 'rounded-[18px] border border-[#E8EAEE] bg-white p-5 shadow-[0_1px_3px_rgba(16,24,40,0.06)]'

const save = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const Step: React.FC<{ number: number; title: string; children: React.ReactNode }> = ({ number, title, children }) => (
  <li className="flex gap-3">
    <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-[#B71920] text-[12px] font-bold text-white">{number}</span>
    <span><strong className="block text-[13.5px] text-[#1F2937]">{title}</strong><span className="mt-0.5 block text-[12.5px] leading-[1.5] text-[#6B7280]">{children}</span></span>
  </li>
)

export const LocalToolsGuide: React.FC = () => {
  const [runner, setRunner] = useState<LocalRunnerStatus | null>(null)
  const [collectorVersion, setCollectorVersion] = useState<string | null | undefined>(undefined)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  usePageHeader({ title: 'Setup & Local Tools', subtitle: 'Install the device runner and browser collector once, then use them from Automation Studio.' })

  const check = async () => {
    setBusy('check')
    try {
      const [nextRunner, nextCollector] = await Promise.all([getLocalRunnerStatus(), installedCollectorVersion()])
      setRunner(nextRunner)
      setCollectorVersion(nextCollector)
    } finally { setBusy(null) }
  }
  useEffect(() => { void check() }, [])
  const downloadRunner = async () => { setBusy('runner'); try { save(await automationService.downloadLocalRunnerPackage(), 'automation-studio-local-runner.zip'); setMessage('Device runner downloaded. Extract it, install once, and keep the runner window open while executing on this device.') } catch (error) { setMessage(error instanceof Error ? error.message : 'The device runner could not be downloaded.') } finally { setBusy(null) } }
  const downloadCollector = async (engine: 'chromium' | 'firefox' | 'safari') => { setBusy(engine); try { save(await automationService.downloadBrowserCollectorPackage(engine), `automation-studio-collector-${engine}.zip`); setMessage('Collector downloaded. Extract it, load it as an unpacked extension, then refresh Automation Studio.') } catch (error) { setMessage(error instanceof Error ? error.message : 'The collector could not be downloaded.') } finally { setBusy(null) } }

  return <div className="space-y-4">
    {message && <div className="rounded-[12px] border border-[#DDE7DF] bg-[#F3FAF5] px-4 py-3 text-[13px] text-[#205B32]">{message}</div>}
    <div role="status" className={`rounded-[14px] border px-4 py-3 text-[13px] ${runner?.ready && collectorVersion === COLLECTOR_VERSION ? 'border-[#B9E1C4] bg-[#F3FAF5] text-[#205B32]' : 'border-[#F1D39A] bg-[#FFFBF4] text-[#6B4A16]'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2"><strong>{runner === null || collectorVersion === undefined ? 'Checking local tools…' : runner.ready && collectorVersion === COLLECTOR_VERSION ? 'Ready: device runner and browser collector detected' : 'Setup needed for one or more local tools'}</strong><button type="button" onClick={() => void check()} disabled={busy !== null} className="rounded-[8px] border border-current px-2.5 py-1 font-bold disabled:opacity-50">{busy === 'check' ? 'Checking…' : 'Check status'}</button></div>
      <p className="mb-0 mt-1">Device runner: {runner?.ready ? `connected${runner.version ? ` (${runner.version})` : ''}` : runner ? 'not detected' : 'checking'} · Browser collector in this tab: {collectorVersion === undefined ? 'checking' : collectorVersion === COLLECTOR_VERSION ? `detected (${collectorVersion})` : collectorVersion ? `version ${collectorVersion}; reload ${COLLECTOR_VERSION}` : 'not detected'}. Detection does not mean a crawl is paired or running; pair when you start a crawl.</p>
    </div>
    <div className="grid gap-4 xl:grid-cols-2">
      <section className={CARD}>
        <div className="flex items-start justify-between gap-3"><div><h2 className="text-[17px] font-bold text-[#1F2937]">Run tests on this device</h2><p className="mt-1 text-[12.5px] text-[#6B7280]">The device runner executes Playwright locally. The browser and Playwright must be available on this device; the production server only coordinates the run.</p></div><span className={`rounded-full px-2.5 py-1 text-[11.5px] font-bold ${runner?.ready ? 'bg-[#EAF7EE] text-[#136B34]' : 'bg-[#FFF4E5] text-[#8A5000]'}`}>{runner?.ready ? `Connected${runner.version ? ` · ${runner.version}` : ''}` : runner ? 'Not detected' : 'Checking…'}</span></div>
        <ol className="mt-5 space-y-4"><Step number={1} title="Download and extract">Download the package below and extract the zip to a permanent folder.</Step><Step number={2} title="Install once">Run the included installer/start file. Allow the local-network prompt if the browser asks.</Step><Step number={3} title="Keep it open and run">Return to Automation Studio, choose Run on this device, then choose headed or headless.</Step></ol>
        <div className="mt-5 flex flex-wrap gap-2"><button onClick={() => void downloadRunner()} disabled={busy !== null} className="h-10 rounded-[11px] bg-[#B71920] px-4 text-[13px] font-bold text-white disabled:opacity-50">{busy === 'runner' ? 'Downloading…' : 'Download device runner'}</button><button onClick={() => void check()} disabled={busy !== null} className="h-10 rounded-[11px] border border-[#E8EAEE] px-4 text-[13px] font-bold text-[#1F2937]">{busy === 'check' ? 'Checking…' : 'Check connection'}</button></div>
      </section>
      <section className={CARD}>
        <div className="flex flex-wrap items-start justify-between gap-2"><div><h2 className="text-[17px] font-bold text-[#1F2937]">Crawl with the browser collector</h2><p className="mt-1 text-[12.5px] text-[#6B7280]">The collector uses the browser profile you already use, including its signed-in session.</p></div><span className={`rounded-full px-2.5 py-1 text-[11.5px] font-bold ${collectorVersion === COLLECTOR_VERSION ? 'bg-[#EAF7EE] text-[#136B34]' : 'bg-[#FFF4E5] text-[#8A5000]'}`}>{collectorVersion === undefined ? 'Checking…' : collectorVersion === COLLECTOR_VERSION ? `Detected · ${collectorVersion}` : collectorVersion ? 'Reload required' : 'Not detected'}</span></div>
        <ol className="mt-5 space-y-4"><Step number={1} title="Download for your browser">Choose the matching package below.</Step><Step number={2} title="Load the extension">Extract the package and load it as an unpacked or temporary extension.</Step><Step number={3} title="Pair and crawl">Open Knowledge Base, choose Browser crawl, then use Auto pair. The pairing code is only a fallback.</Step></ol>
        <div className="mt-5 flex flex-wrap gap-2"><button onClick={() => void downloadCollector('chromium')} disabled={busy !== null} className="h-10 rounded-[11px] bg-[#B71920] px-4 text-[13px] font-bold text-white">Chrome, Edge, Brave</button><button onClick={() => void downloadCollector('firefox')} disabled={busy !== null} className="h-10 rounded-[11px] border border-[#E8EAEE] px-4 text-[13px] font-bold">Firefox</button><button onClick={() => void downloadCollector('safari')} disabled={busy !== null} className="h-10 rounded-[11px] border border-[#E8EAEE] px-4 text-[13px] font-bold">Safari source</button></div>
      </section>
    </div>
    <section className={CARD}>
      <h2 className="text-[17px] font-bold text-[#1F2937]">Device runner: paths to set if a run fails</h2>
      <p className="mt-1 text-[12.5px] leading-relaxed text-[#6B7280]">If you see an error such as <span className="font-semibold text-[#1F2937]">“@playwright/test is not installed”</span> or the browser cannot be found, set the two paths below on the computer running the device runner. They are needed for that setup; the runner may find them automatically on other computers.</p>
      <div className="mt-4 rounded-[12px] border border-[#F1D39A] bg-[#FFFBF4] p-3 text-[12.5px] text-[#6B4A16]"><strong>Use your own paths.</strong> The Windows username and folder names below are examples, not fixed installation locations. In File Explorer, find your Playwright project folder and the actual <code>chrome.exe</code> (or <code>msedge.exe</code>) on your device, then replace the example paths before running these commands.</div>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <div className="min-w-0 rounded-[12px] border border-[#E8EAEE] p-4">
          <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-[#B71920]">Required when Playwright is not found</div>
          <p className="mt-1 text-[12.5px] text-[#6B7280]">Point to the project folder containing <code>node_modules\@playwright\test</code>, not to the runner zip or a Python Playwright folder.</p>
          <pre className="app-scroll mt-3 overflow-x-auto rounded-[9px] bg-[#1F2937] p-3 font-mono text-[11.5px] text-white"><code>{'setx AUTOMATION_PLAYWRIGHT_PROJECT "C:\\Users\\melsemary\\Documents\\APPS\\AI Project\\Playwright"'}</code></pre>
        </div>
        <div className="min-w-0 rounded-[12px] border border-[#E8EAEE] p-4">
          <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-[#B71920]">Required when the browser is not found</div>
          <p className="mt-1 text-[12.5px] text-[#6B7280]">Point to the browser executable file itself. Chrome is shown here; use your installed browser’s real location.</p>
          <pre className="app-scroll mt-3 overflow-x-auto rounded-[9px] bg-[#1F2937] p-3 font-mono text-[11.5px] text-white"><code>{'setx AUTOMATION_BROWSER_EXECUTABLE "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"'}</code></pre>
        </div>
      </div>
      <div className="mt-3 rounded-[12px] border border-[#E8EAEE] bg-[#FCFCFD] p-4">
        <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-[#6B7280]">Optional · video only</div>
        <p className="mt-1 text-[12.5px] text-[#6B7280]">Set FFmpeg only if you need video and the runner cannot find it. Tests can still run without it; screenshots and traces remain available.</p>
        <pre className="app-scroll mt-3 overflow-x-auto rounded-[9px] bg-[#1F2937] p-3 font-mono text-[11.5px] text-white"><code>{'setx AUTOMATION_FFMPEG_PATH "C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe"'}</code></pre>
      </div>
      <p className="mt-3 text-[12.5px] text-[#6B7280]">Run the commands in Windows Command Prompt, then close and reopen the device runner and select <strong>Check connection</strong> above. If the error continues, confirm each path exists and that Playwright is installed in the chosen project.</p>
    </section>
    <div className="rounded-[14px] border border-[#E8EAEE] bg-[#FCFCFD] px-4 py-3 text-[12.5px] text-[#6B7280]">Still blocked? Keep the runner window open, refresh this page, and select Check connection. Corporate browser policies may require local-network access to <span className="font-mono text-[#1F2937]">127.0.0.1</span>.</div>
  </div>
}

export const ApplicationGuide: React.FC = () => {
  usePageHeader({ title: 'Application Guide', subtitle: 'A practical path from requirement to browser evidence, approval and execution.' })
  const stages = [
    ['1', 'Create test cases', 'Upload a BRD in Test Assistant, generate the test cases, review the output, then save it.'],
    ['2', 'Check with agents', 'Agents Refine is recommended for new projects. It prepares journeys, captures browser evidence and checks the cases. Use Knowledge Base AI Refine only when the project KB is already prepared.'],
    ['3', 'Review the result', 'Approval Manager publishes evidence-backed KB changes when enabled; uncertain mappings remain unresolved. Send completed cases to Human Evaluation for the manager’s decision.'],
    ['4', 'Prepare automation', 'Knowledge Base shows authored journeys, captured controls, approved mappings and Test Data coverage separately. Resolve missing mappings or data before generating a script in Automation Studio.'],
    ['5', 'Run and improve', 'Choose server or device execution, monitor progress and inspect failures. Update the KB only from verified browser evidence.']
  ]
  return <div className="space-y-4">
    <section className={CARD}>
      <h2 className="text-[17px] font-bold text-[#1F2937]">From requirement to reliable test</h2>
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">{stages.map(([number, title, detail]) => <div key={number} className="rounded-[14px] border border-[#E8EAEE] bg-[#FCFCFD] p-4"><span className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#B71920]">Step {number}</span><h3 className="mt-2 text-[14px] font-bold text-[#1F2937]">{title}</h3><p className="mt-1 text-[12px] leading-[1.5] text-[#6B7280]">{detail}</p></div>)}</div>
    </section>
    <section className={CARD}>
      <h2 className="text-[17px] font-bold">Before you start: application and tools</h2>
      <ol className="mt-4 space-y-3"><Step number={1} title="Register the application">In Knowledge Base, select or register the project application. Set its address for the environment in Test Data.</Step><Step number={2} title="Install the browser collector for capture">Download the extension that matches your browser from Setup &amp; Local Tools, load it, and check that it is detected in this tab. A crawl pairs the extension when started.</Step><Step number={3} title="Install the device runner for local execution">Only needed if you choose Run on this device. Keep it open on a computer with Playwright and a browser, then check connection.</Step></ol>
      <div className="mt-3 flex flex-wrap gap-4 text-[13px]"><Link to="/automation/knowledge-base" className="font-bold text-[#941216] underline">Open Knowledge Base →</Link><Link to="/guides/local-tools" className="font-bold text-[#941216] underline">Check local tools →</Link></div>
    </section>
    <section className={CARD}>
      <h2 className="text-[17px] font-bold">Create cases and choose the right check</h2>
      <p className="mt-2 text-[13px] leading-6 text-[#4B5563]">In Test Assistant, upload the requirement document, generate cases, inspect the output and save the draft. Select the cases you want to check and press <strong>Check</strong>. Saving alone does not run agents.</p>
      <div className="mt-3 grid gap-3 lg:grid-cols-3 text-[12.5px] leading-5">
        <div className="rounded-[12px] border border-[#B9E1C4] bg-[#F3FAF5] p-3"><strong>Agents Refine · recommended</strong><p className="mb-0 mt-1">Use for new or incomplete project knowledge. Select project and environment. The six built-in specialists start automatically; you do not create agents manually.</p></div>
        <div className="rounded-[12px] border border-[#D7E2F0] bg-[#F5F9FF] p-3"><strong>Knowledge Base AI Refine</strong><p className="mb-0 mt-1">Use when the project already has prepared journeys and mappings. It checks against existing KB context, without a new guided crawl.</p></div>
        <div className="rounded-[12px] border border-[#E8EAEE] bg-[#FCFCFD] p-3"><strong>Proceed without refine · not recommended</strong><p className="mb-0 mt-1">Sends saved cases to Human Evaluation unchanged; no AI or browser check runs.</p></div>
      </div>
      <Link to="/test-assistant/testcases" className="mt-3 inline-block text-[13px] font-bold text-[#941216] underline">Open Test Assistant cases →</Link>
    </section>
    <section className={CARD}>
      <h2 className="text-[17px] font-bold">Follow agents, crawl and evidence</h2>
      <p className="mt-2 text-[13px] leading-6 text-[#4B5563]">Agent cards show their status and <strong>View work</strong> explains the handoff. A crawl shows pages, controls, blocked routes and steps reached. If an agent fails, retry that stage where offered; <strong>Restart</strong> begins the entire selected case again. When a control is missing or ambiguous, capture it on the correct host and screen. Never treat a captured control as an approved executable locator.</p>
      <p className="mt-2 text-[13px] leading-6 text-[#4B5563]">If the collector is not detected, reload the extension and check its status. If data is missing, add values for the selected environment in Test Data, then retry the affected work. Approval Manager can publish evidence-backed KB changes; uncertain proposals remain held with a reason.</p>
      <div className="mt-3 flex flex-wrap gap-4 text-[13px]"><Link to="/automation/knowledge-base?stage=reconcile" className="font-bold text-[#941216] underline">Inspect mappings →</Link><Link to="/test-data" className="font-bold text-[#941216] underline">Open Test Data →</Link></div>
    </section>
    <section className={CARD}>
      <h2 className="text-[17px] font-bold">Evaluate, generate and run</h2>
      <p className="mt-2 text-[13px] leading-6 text-[#4B5563]">Send completed cases to Human Evaluation. The manager selects an application and approves automation-ready cases or leaves them manual. This case decision is separate from Approval Manager’s KB decision. In Automation Studio, open an approved case, inspect readiness, resolve missing locators or values, generate the script, and choose server or device execution.</p>
      <p className="mt-2 text-[13px] leading-6 text-[#4B5563]">Watch the run and inspect the failing step, screenshot and trace. If you use Heal with AI, review the proposed change and rerun it; generated code and static checks do not prove a browser run passed.</p>
      <div className="mt-3 flex flex-wrap gap-4 text-[13px]"><Link to="/manager-review" className="font-bold text-[#941216] underline">Human Evaluation →</Link><Link to="/automation/script-lab" className="font-bold text-[#941216] underline">Automation Studio →</Link><Link to="/guides/documentation" className="font-bold text-[#941216] underline">Detailed documentation →</Link></div>
    </section>
  </div>
}

export const ProjectDocumentation: React.FC = () => {
  usePageHeader({ title: 'Documentation', subtitle: 'Operating instructions, evidence states and recovery steps.' })
  return <div className="space-y-4">
    <section className={CARD}><h2 className="text-[17px] font-bold">Start here</h2><p className="mt-2 text-[13px] leading-6 text-[#4B5563]">A Knowledge Base decision and a test-case decision are different. Evidence-backed KB changes can be accepted by Approval Manager during Agents Refine; Human Evaluation is where a manager approves a case for automation. Follow the <Link to="/guides/application" className="font-bold text-[#941216] underline">Application Guide</Link> for the step-by-step path.</p></section>
    <section className={CARD}>
      <h2 className="text-[17px] font-bold">Test Assistant and the agent team</h2>
      <ol className="mt-3 list-decimal space-y-2 pl-5 text-[13px] leading-6 text-[#4B5563]"><li>Upload a requirement document, generate test cases, review and save the draft. Select the cases to check.</li><li>For Agents Refine, choose the project and environment. The specialists are built into the check; you do not create or install agents yourself. Keep Approval Manager enabled if you want supported KB changes decided automatically.</li><li>Read each card and <strong>View work</strong>. Requirements Guide checks the saved actions; Navigation Guide maps the journey; Automation Expert checks browser readiness and replay; Analysis Expert and Audit Expert refine and assess the result; Data Entry Expert prepares data or KB changes. Expert Editor and Approval Manager review in parallel.</li><li>If an agent fails, read its reason and use its stage retry when offered. <strong>Restart</strong> starts the selected case again from the beginning. A retry is not proof of success; check the new evidence.</li><li>Send completed cases to Human Evaluation. A case with an unsafe mapping may still be evaluated as manual.</li></ol>
      <Link to="/test-assistant/testcases" className="text-[13px] font-bold text-[#941216] underline">Open Test Assistant cases →</Link>
    </section>
    <section className={CARD}>
      <h2 className="text-[17px] font-bold">Knowledge Base: what each area means</h2>
      <div className="mt-3 grid gap-3 md:grid-cols-2 text-[13px] leading-6 text-[#4B5563]"><p className="m-0"><strong>Journey KB</strong> stores authored journeys, steps and design screens. Agent-authored steps can exist even when no BRD or source document is linked.</p><p className="m-0"><strong>App Model</strong> catalogues screens and observed controls. Observation records what appeared in the browser; it does not automatically make a locator executable.</p><p className="m-0"><strong>Automation KB</strong> holds approved selector links and flows. “Captured · not mapped” means browser evidence exists but the approved locator link is absent. “Not crawled” means no observed control or approved mapping is present for that element.</p><p className="m-0"><strong>Test Data</strong> stores environment-specific values in the vault. Knowledge Base displays profile and coverage status, not the secret values. One environment can be ready while another is missing values.</p></div>
      <p className="mt-3 text-[13px] leading-6 text-[#4B5563]">Use Journey Map to compare each step with its screen, selector and flow. Use Reconcile to investigate missing mappings or drift. A mapping must be grounded in controls observed on the correct application host and screen; if the evidence is absent or ambiguous, leave it unresolved and capture more.</p>
      <Link to="/automation/knowledge-base" className="text-[13px] font-bold text-[#941216] underline">Open Knowledge Base →</Link>
    </section>
    <section className={CARD}>
      <h2 className="text-[17px] font-bold">Browser collector and device runner</h2>
      <div className="mt-3 grid gap-3 md:grid-cols-2 text-[13px] leading-6 text-[#4B5563]"><div className="rounded-[12px] border border-[#E8EAEE] p-3"><strong>Collector · capture pages and controls</strong><p className="mb-0 mt-1">Download the matching browser extension, load it, then check its status in Setup &amp; Local Tools. Start Browser crawl in Knowledge Base or an agent-guided capture. Auto pair starts the extension; use the one-time code if automatic pairing fails. Watch the pages, controls, blocked routes and steps reported by the crawl. “Detected” only means the extension responded in this tab.</p></div><div className="rounded-[12px] border border-[#E8EAEE] p-3"><strong>Runner · execute Playwright locally</strong><p className="mb-0 mt-1">Install and keep the runner open on a machine with Playwright and a browser. Check connection, then choose Run on this device in Automation Studio. Headed mode shows the browser; headless does not. A connected runner can still encounter missing data or a locator failure.</p></div></div>
      <Link to="/guides/local-tools" className="mt-3 inline-block text-[13px] font-bold text-[#941216] underline">Setup instructions and current status →</Link>
    </section>
    <section className={CARD}>
      <h2 className="text-[17px] font-bold">Evaluation, execution and recovery</h2>
      <ul className="mt-3 list-disc space-y-2 pl-5 text-[13px] leading-6 text-[#4B5563]"><li><strong>KB proposal held:</strong> open the agent work or change set to read why. Do not publish an ambiguous locator to clear the warning; capture the correct screen or keep the case manual.</li><li><strong>Missing Test Data:</strong> open Test Data for the selected application and environment, save the required values, then retry the affected work. Sign-in tests need a usable test account, not invented credentials.</li><li><strong>Case needs evaluation:</strong> send completed cases to Human Evaluation. The manager selects an application and approves automation-ready cases; that is separate from Approval Manager’s KB decision.</li><li><strong>Script failed:</strong> inspect the failed step and browser evidence in Automation Studio. Heal with AI may propose a repair, but review and rerun it. Generated code and static checks do not establish a successful browser run.</li></ul>
      <div className="flex flex-wrap gap-4 text-[13px]"><Link to="/test-data" className="font-bold text-[#941216] underline">Test Data →</Link><Link to="/manager-review" className="font-bold text-[#941216] underline">Human Evaluation →</Link><Link to="/automation/script-lab" className="font-bold text-[#941216] underline">Automation Studio →</Link></div>
    </section>
  </div>
}
