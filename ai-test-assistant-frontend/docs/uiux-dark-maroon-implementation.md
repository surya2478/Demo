## Dark Maroon UI/UX Implementation Note

### Files Reviewed

- `src/routes.tsx`
- `src/components/Sidebar.tsx`
- `src/components/Navbar.tsx`
- `src/index.css`
- `src/styles/theme.ts`
- `tailwind.config.js`
- `tailwind.config.ts`
- `src/components/shared/Button.tsx`
- `src/components/TokenUsageCard.tsx`
- `src/components/ChatWindow.tsx`
- `src/components/Loader.tsx`
- `src/components/Notification.tsx`
- `src/pages/Dashboard.tsx`
- `src/pages/TestAssistant.tsx`
- `src/pages/test-assistant/TestCases.tsx`
- `src/pages/test-assistant/Visual.tsx`
- `src/pages/test-assistant/DataTab.tsx`
- `src/pages/test-assistant/Changes.tsx`
- `src/pages/test-assistant/Unit.tsx`
- `src/pages/test-assistant/KB.tsx`
- `src/pages/Users.tsx`
- `src/pages/UserTimeSlots.tsx`
- `src/pages/Sessions.tsx`
- `src/pages/AuditLogs.tsx`
- `src/pages/Reports.tsx`
- `src/pages/RequestTrackerReport.tsx`
- `src/pages/Settings.tsx`
- `src/pages/Team.tsx`
- `src/pages/Login.tsx`
- `src/pages/Unauthorized.tsx`

### Shared UI Components To Create Or Reuse

- `src/components/ui/AppPageHeader.tsx`
- `src/components/ui/SectionCard.tsx`
- `src/components/ui/StatCard.tsx`
- `src/components/ui/StatusBadge.tsx`
- `src/components/ui/TableToolbar.tsx`
- `src/components/ui/EmptyState.tsx`
- Modernized shared primitives:
  - `src/components/shared/Button.tsx`
  - `src/components/Loader.tsx`
  - `src/components/Notification.tsx`

### Page Migration Order

1. Tokens and global surface styles
2. Shared button, cards, badges, loading, empty, notification states
3. Active shell in `Sidebar`, `Navbar`, and protected layout
4. Dashboard and Test Assistant workspace
5. Reports, audit, settings, users, sessions, login, unauthorized, and remaining admin views

### Design Token Mapping

- Primary dark shell: `brand-950`, `brand-900`
- Primary action: `brand-800`
- Hover/active action: `brand-600`, `brand-500`
- Selected light surfaces: `brand-100`, `brand-75`, `brand-50`
- App canvas: `canvas`
- Base cards: `surface`
- Soft borders: `border`, `border-strong`
- Text hierarchy: `text-primary`, `text-secondary`, `text-muted`
- Semantic colors preserved for meaning:
  - success green
  - warning amber
  - danger red
  - neutral slate

### Functional Safety Statement

This refactor is limited to UI and UX presentation. Routes, APIs, authentication, RBAC, audit logging, token tracking, upload behavior, export behavior, streaming logic, and business handlers remain untouched.
