import React, { useMemo, useRef, useEffect, useState } from 'react';
import { useLocation, useOutlet } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { formatToDubaiTime } from '../utils/formatToDubaiTime';
import { TestDataProvider } from '../context/TestDataContext';
import { usePageHeader } from '../components/layout/PageHeaderContext';
import TestingToolsMenu, { type TestingTool } from '../components/test-assistant/TestingToolsMenu';
import TokenUsageChip from '../components/test-assistant/TokenUsageChip';

const allTabs = [
  { to: 'testcases', label: 'Test Cases', permission: 'view_testcases' },
  { to: 'visual', label: 'Visual Testing', permission: 'view_visual' },
  { to: 'data', label: 'Test Data', permission: 'view_testdata' },
  { to: 'changes', label: 'Change Impact', permission: 'view_changes' },
  { to: 'unit', label: 'Unit Tests', permission: 'view_unit' },
  { to: 'kb', label: 'Knowledge Base', permission: 'view_kb' }
];

const hasPermission = (user: any, permission: string) => {
  if (!user) return false;
  const roles: string[] = (user.roles as string[]) || (user.role ? [user.role] : []);
  if (roles.some(r => String(r).toLowerCase() === 'admin')) return true;
  const perms: string[] = (user.permissions as string[]) || [];
  if (perms.includes(permission)) return true;
  if (roles.includes(permission)) return true;
  return false;
};

type TabGlyphProps = {
  className?: string;
};

const ClipboardGlyph: React.FC<TabGlyphProps> = ({ className = '' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 4.75h6M9.75 3h4.5a1.5 1.5 0 011.5 1.5V6h1.75A2.25 2.25 0 0120 8.25v10.5A2.25 2.25 0 0117.75 21H6.25A2.25 2.25 0 014 18.75V8.25A2.25 2.25 0 016.25 6H8V4.5A1.5 1.5 0 019.5 3z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M8.5 10h7M8.5 13.5h7M8.5 17h4.5" />
  </svg>
);

const VisualGlyph: React.FC<TabGlyphProps> = ({ className = '' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className}>
    <rect x="3.5" y="5" width="17" height="14" rx="2.25" />
    <circle cx="9" cy="10" r="1.6" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M6.5 16l3.2-3.2a1 1 0 011.4 0l2.4 2.4a1 1 0 001.4 0l1.6-1.6a1 1 0 011.4 0l2.1 2.1" />
  </svg>
);

const DatabaseGlyph: React.FC<TabGlyphProps> = ({ className = '' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className}>
    <ellipse cx="12" cy="6.5" rx="6.5" ry="2.75" />
    <path d="M5.5 6.5v5c0 1.52 2.9 2.75 6.5 2.75s6.5-1.23 6.5-2.75v-5" />
    <path d="M5.5 11.5v5c0 1.52 2.9 2.75 6.5 2.75s6.5-1.23 6.5-2.75v-5" />
  </svg>
);

const ImpactGlyph: React.FC<TabGlyphProps> = ({ className = '' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M13 2.75L6.75 13H11l-1 8.25L17.25 11H13L13 2.75z" />
  </svg>
);

const UnitGlyph: React.FC<TabGlyphProps> = ({ className = '' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5.5L5.5 12 9 18.5M15 5.5l3.5 6.5-3.5 6.5M13.25 4l-2.5 16" />
  </svg>
);

const KnowledgeGlyph: React.FC<TabGlyphProps> = ({ className = '' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 4.5h8.5A2.75 2.75 0 0118 7.25v11.25a1 1 0 01-1.5.86L12 16.75l-4.5 2.61a1 1 0 01-1.5-.86V7.25A2.75 2.75 0 018.75 4.5z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 8.5h6M9 11.75h6" />
  </svg>
);

const HeroCodeGlyph: React.FC<TabGlyphProps> = ({ className = '' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 7L4.5 12 9 17M15 7l4.5 5-4.5 5M13.5 5l-3 14" />
  </svg>
);

const HeroChartGlyph: React.FC<TabGlyphProps> = ({ className = '' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 19.25h14" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 16V11.5M12 16V8M16.5 16V5.5" />
  </svg>
);

const tabVisuals: Record<string, { detail: string; Icon: React.FC<TabGlyphProps> }> = {
  testcases: { detail: 'Scenarios and coverage', Icon: ClipboardGlyph },
  visual: { detail: 'Screens, flows and assets', Icon: VisualGlyph },
  data: { detail: 'Structured data generation', Icon: DatabaseGlyph },
  changes: { detail: 'Impact and regression review', Icon: ImpactGlyph },
  unit: { detail: 'Developer-ready cases', Icon: UnitGlyph },
  kb: { detail: 'Guides and references', Icon: KnowledgeGlyph }
};

// ============================================================================
// HELPER FUNCTIONS FOR AUDIT DETAILS BUILDING
// ============================================================================

/**
 * Mask sensitive values (passwords, tokens, etc.)
 */
const maskValue = (fieldName: string, value: any): string => {
  if (value === null || value === undefined) return '';
  const name = String(fieldName || '').toLowerCase();
  // mask sensitive fields
  if (/(password|passwd|secret|token|ssn|credit|card|apikey|api_key)/i.test(name)) {
    return '***MASKED***';
  }
  const str = String(value);
  if (str.length > 250) return str.slice(0, 250) + '…';
  return str;
};

/**
 * Generate human-readable description for navigation
 */
const buildNavigationDescription = (
  fromTab: string | null,
  toTab: string,
  fromLabel: string | null,
  toLabel: string
): string => {
  if (!fromTab) {
    return `User accessed Test Assistant and navigated to ${toLabel}`;
  }
  return `User navigated from ${fromLabel} to ${toLabel}`;
};

/**
 * Build session info (masked)
 */
const buildSessionInfo = (user: any): any => {
  if (!user) return null;
  // simple session id generation (hash of user + timestamp)
  const sessionId = `${String(user.username || 'user').slice(0, 6)}-${Math.random().toString(36).slice(2, 8)}...${Date.now().toString(36).slice(-4)}`;
  return {
    session_id: sessionId,
    status: 'active',
    expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() // +2hrs
  };
};

/**
 * Build environment/context info
 */
const buildEnvironmentInfo = (): any => {
  return {
    ip: 'CLIENT_IP', // backend will fill this
    user_agent: navigator.userAgent,
    source: 'web',
    platform: navigator.platform,
    language: navigator.language
  };
};

/**
 * Build detailed audit entry (navigation)
 */
const buildDetailedNavigationAudit = (
  user: any,
  fromTab: string | null,
  toTab: string,
  fromLabel: string | null,
  toLabel: string
) => {
  const dubai = formatToDubaiTime(new Date().toISOString());
  const description = buildNavigationDescription(fromTab, toTab, fromLabel, toLabel);

  return {
    timestamp: dubai,
    description,
    context: {
      from_tab: fromLabel,
      to_tab: toLabel,
      transition_type: fromTab ? 'tab_switch' : 'module_entry'
    },
    session: buildSessionInfo(user),
    environment: buildEnvironmentInfo()
  };
};

// ============================================================================
// COMPONENT
// ============================================================================

const TestAssistant: React.FC = () => {
  const { user } = useAuth();
  const location = useLocation();
  const outlet = useOutlet();
  const previousTabRef = useRef<string | null>(null);
  const didInitRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputTimersRef = useRef<Record<string, number>>({});
  const previousValuesRef = useRef<Record<string, string>>({});
  const outletCacheRef = useRef<Record<string, React.ReactElement | null>>({}); // cache outlet elements by pathname
  
  // Chat state management - independent session per tab
  const [chatSessions, setChatSessions] = useState<Record<string, Array<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: string }>>>({});
  const [isChatOpen, setIsChatOpen] = useState(false);

  const tabs = useMemo(() => {
    return allTabs.filter(t => hasPermission(user, t.permission));
  }, [user]);

  // The tab bar is gone: the modes live in the top bar's Testing tools menu,
  // next to search and token usage.
  const testingTools = useMemo<TestingTool[]>(
    () =>
      tabs.map((t) => {
        const visual = tabVisuals[t.to] ?? tabVisuals.testcases;
        return { to: `/test-assistant/${t.to}`, label: t.label, detail: visual.detail, Icon: visual.Icon };
      }),
    [tabs]
  );

  usePageHeader({
    showSearch: true,
    searchPlaceholder: 'Search users, logs, test activity...',
    showAssistant: true,
    showNotifications: true,
    showDateRange: true,
    dateRangeLabel: 'Last 24 hours',
    notificationCount: 1,
    leading: <TestingToolsMenu tools={testingTools} />,
    actions: <TokenUsageChip />,
    contentKey: tabs.map((t) => t.to).join(',')
  });

  const currentTab = useMemo(() => {
    const pathname = location?.pathname || '';
    if (!pathname || typeof pathname !== 'string') return null;
    const pathParts = pathname.split('/');
    return pathParts[pathParts.length - 1] || null;
  }, [location.pathname]);

  const currentTabLabel = useMemo(() => {
    return tabs.find(t => t.to === currentTab)?.label || currentTab || 'Test Assistant';
  }, [tabs, currentTab]);

  // Initialize empty chat session for new tabs
  useEffect(() => {
    if (currentTab && !chatSessions[currentTab]) {
      setChatSessions(prev => ({
        ...prev,
        [currentTab]: []
      }));
    }
  }, [currentTab, chatSessions]);

  // Log tab navigation with descriptive details
  useEffect(() => {
    if (!didInitRef.current) {
      didInitRef.current = true;
      previousTabRef.current = currentTab;
      return;
    }

    if (currentTab && currentTab !== previousTabRef.current) {
      const prevLabel = previousTabRef.current ? (tabs.find(t => t.to === previousTabRef.current)?.label || previousTabRef.current) : null;

      console.log(`[TestAssistant] Tab changed from "${previousTabRef.current}" to "${currentTab}"`);

      previousTabRef.current = currentTab;
    }
  }, [currentTab, currentTabLabel, tabs, user]);

  const focusedFieldRef = useRef<string | null>(null);
  const fieldValuesRef = useRef<Record<string, string>>({});
  const originalFieldValuesRef = useRef<Record<string, string>>({}); // <-- store value at focus time

  // keep cache in sync with the active outlet
  useEffect(() => {
    if (outlet) {
      outletCacheRef.current[location.pathname] = outlet;
    }
  }, [location.pathname, outlet]);

  // remove cache entries for tabs that are no longer valid (optional)
  // example: keep only the tabs that are in `tabs` list (prevents memory growth)
  useEffect(() => {
    const validPaths = new Set(tabs.map(t => `${t.to}`)); // if routes are nested as /testassistant/<tab> adjust accordingly
    // We want to preserve exact pathname(s); attempt matching last segment
    Object.keys(outletCacheRef.current).forEach((p) => {
      if (!p || typeof p !== 'string') return;
      const pathLast = p.split('/').pop();
      if (pathLast && !validPaths.has(pathLast)) {
        delete outletCacheRef.current[p];
      }
    });
  }, [tabs]);

  const handleAddMessage = (role: 'user' | 'assistant', content: string) => {
    if (!currentTab) return;
    
    setChatSessions(prev => ({
      ...prev,
      [currentTab]: [
        ...(prev[currentTab] || []),
        {
          id: Date.now().toString(),
          role,
          content,
          timestamp: new Date().toISOString()
        }
      ]
    }));
  };

  const currentTabMessages = currentTab ? (chatSessions[currentTab] || []) : [];
  const currentTabMeta = currentTab ? tabVisuals[currentTab] : null;

  return (
    <TestDataProvider>
    <div ref={containerRef} className="relative space-y-4">
      {/* Hero — compact 2-column header */}
      <section className="overflow-hidden rounded-[20px] border border-app bg-app-surface shadow-app-card">
        <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_460px]">
          <div className="px-5 py-4 sm:px-6">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-app-brand-700">
              Workspace
            </p>
            <h1 className="mt-1 text-[26px] font-bold leading-tight tracking-[-0.02em] text-app-primary">
              <span className="text-app-brand-700">AI</span> Testing Assistant
            </h1>
            <p className="mt-1.5 max-w-xl text-[13px] leading-5 text-app-secondary">
              Generate test assets, review output, and work across all testing modes without changing permissions, routes, or flows.
            </p>
          </div>

          <div className="relative h-[140px] overflow-hidden border-t border-app bg-[radial-gradient(circle_at_50%_38%,rgba(255,255,255,1),rgba(255,255,255,0.96)_35%,rgba(253,235,236,0.78)_58%,rgba(255,255,255,0.98)_100%)] lg:h-auto lg:border-l lg:border-t-0">
            <div className="absolute inset-0">
              <div className="assistant-hero-ring assistant-hero-ring-outer absolute left-1/2 top-1/2 h-[150px] w-[150px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-app-brand-200/60" />
              <div className="assistant-hero-ring assistant-hero-ring-middle absolute left-1/2 top-1/2 h-[118px] w-[118px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-app-brand-100/70" />
              <div className="assistant-hero-ring assistant-hero-ring-inner absolute left-1/2 top-1/2 h-[88px] w-[88px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-app-brand-200/70 shadow-[0_0_0_10px_rgba(183,25,32,0.04)]" />
              <div className="assistant-hero-core absolute left-1/2 top-1/2 h-[68px] w-[68px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle_at_32%_28%,#ff9296_0,#d71e23_48%,#880d13_100%)] shadow-[0_10px_24px_rgba(148,18,22,0.26)]" />
              <div className="absolute left-1/2 top-1/2 flex h-[68px] w-[68px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-[30px] font-bold tracking-[-0.06em] text-white">
                AI
              </div>

              <div className="assistant-hero-tile assistant-hero-tile-left absolute left-[14%] top-[24%] flex h-9 w-9 rotate-[-18deg] items-center justify-center rounded-[12px] border border-app-brand-100 bg-white/90 text-app-brand-700 shadow-[0_8px_18px_rgba(183,25,32,0.1)]">
                <HeroCodeGlyph className="h-5 w-5" />
              </div>
              <div className="assistant-hero-tile assistant-hero-tile-right absolute right-[12%] top-[28%] flex h-9 w-9 rotate-[14deg] items-center justify-center rounded-[12px] border border-app-brand-100 bg-white/90 text-app-brand-700 shadow-[0_8px_18px_rgba(183,25,32,0.1)]">
                <HeroChartGlyph className="h-5 w-5" />
              </div>
              <div className="assistant-hero-dot assistant-hero-dot-one absolute left-[16%] top-[64%] h-2.5 w-2.5 rounded-md bg-app-brand-500 shadow-[0_0_0_6px_rgba(183,25,32,0.08)]" />
              <div className="assistant-hero-dot assistant-hero-dot-two absolute right-[20%] top-[16%] h-2 w-2 rounded-[3px] bg-app-brand-500" />
              <div className="assistant-hero-dot assistant-hero-dot-three absolute right-[26%] top-[70%] h-2.5 w-2.5 rounded-md bg-app-brand-300" />
            </div>
          </div>
        </div>
      </section>

      {/* Tab content — no extra wrapper */}
      <div>
        {(() => {
          const entries = Object.entries(outletCacheRef.current);
          const hasCachedCurrent = Boolean(outletCacheRef.current[location.pathname]);

          if (outlet && !hasCachedCurrent) {
            entries.push([location.pathname, outlet]);
          }

          return entries.map(([path, el]) => (
            <div
              key={path}
              style={{ display: path === location.pathname ? 'block' : 'none' }}
              aria-hidden={path !== location.pathname}
            >
              {el}
            </div>
          ));
        })()}
      </div>

      {/* Chat Window - Fixed bottom-right */}
      {/* <ChatWindow
        isOpen={isChatOpen}
        onToggle={() => setIsChatOpen(!isChatOpen)}
        messages={currentTabMessages}
        onAddMessage={handleAddMessage}
        currentTab={currentTabLabel}
        userName={user?.username || 'User'}
      /> */}
    </div>
    </TestDataProvider>
  );
};

export default TestAssistant;
