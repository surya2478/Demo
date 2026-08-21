# UI/UX Maroon Reference Implementation

## Status: In Progress — Phase 1 through Phase 5

---

## Files and Routes Reviewed

### Routes inspected
- `/login` — Login.tsx
- `/dashboard` — Dashboard.tsx
- `/users` — Users.tsx
- `/user-time-slots` — UserTimeSlots.tsx
- `/sessions` — Sessions.tsx
- `/audit-logs` — AuditLogs.tsx
- `/reports` — Reports.tsx
- `/request-tracker-report` — RequestTrackerReport.tsx
- `/settings` — Settings.tsx
- `/team` — Team.tsx
- `/test-assistant` (+ nested tabs: testcases, visual, data, changes, unit, kb) — TestAssistant.tsx + subdirectory pages

### Key files reviewed
- `src/routes.tsx` — active router, LayoutShell (sidebar + topheader + outlet), ProtectedLayout
- `src/components/Sidebar.tsx` — dark-maroon gradient sidebar, workspace selector, user card, RBAC nav
- `src/components/layout/TopHeader.tsx` — sticky top bar with title/subtitle, search, AI Assistant, notifications, date range
- `src/components/layout/PageHeaderContext.tsx` — page-level meta publisher (title, subtitle, actions, search callbacks)
- `src/index.css` — global CSS variables, base styles, `app-table`, `app-input`, `app-btn` utilities
- `src/tailwind.config.js` — all color tokens, box shadows, border radius
- `src/styles/theme.ts` — theme object for button, input, card, badge, nav classes
- `src/components/ui/` — MetricCard, SectionCard, StatusBadge, IconBadge, EmptyState, AIInsightCard, StatCard, AppPageHeader, ChartCard, LoadingSkeleton, TableToolbar

---

## Current Active Shell and Design Configuration

**Shell**: `LayoutShell` in `src/routes.tsx` — composes `Sidebar` + `TopHeader` + `<Outlet />`

**Design System**: Tailwind CSS 3.4 with custom tokens under `app.*` prefix. The maroon palette is already fully defined from `app-brand-950` (#4D0507) to `app-brand-50` (#FFF8F8).

**Sidebar**: Dark maroon gradient (`#7A0B0D → #65080A → #4D0507`) — already correctly styled per references.

**Active color palette** (from `tailwind.config.js`):
```
brand-950: #4D0507  brand-900: #65080A  brand-800: #7A0B0D
brand-700: #941216  brand-600: #B71920  brand-500: #D52B31
brand-300: #F1A4A6  brand-200: #F6D4D5  brand-100: #FDEBEC
brand-75:  #FFF5F5  brand-50:  #FFF8F8
canvas:    #F8F9FB  surface:   #FFFFFF  border:    #E8EAEE
```

---

## Existing Controls That Cannot Be Changed

The following are functional — visual only passes are permitted but logic must not be altered:
- User CRUD operations (create/edit/delete) — `Users.tsx`, `UserModal.tsx`, `EditUserModal.tsx`
- Login/auth flow — `Login.tsx`, `useAuth`, `ProtectedRoute`
- Audit logging via `logApiEvent` and `auditService`
- Token tracking via `RequestTrackerAPI` and `trackedFetchWithTokens`
- AI generation endpoints, streaming, and token extraction — `TestCases.tsx` etc.
- Excel export and file download — `exportToExcel()` in `TestCases.tsx`
- Chat/KB functionality — `ChatWindow.tsx`, `KB.tsx`
- Session management — `Sessions.tsx`
- Settings load/save — `settingsService`
- RBAC permission checks — `ProtectedRoute`, `hasPermission()`
- All route definitions and redirect logic in `routes.tsx`

---

## Reusable UI Components Created/Improved

### Already present in `src/components/ui/`:
- `MetricCard.tsx` — Enhanced with optional `sparkData?: number[]` inline sparkline
- `SectionCard.tsx` — Table-compatible card with header/footer
- `StatusBadge.tsx` — Semantic status chips (success/warning/danger/brand/neutral)
- `IconBadge.tsx` — Icon in a tinted rounded container
- `EmptyState.tsx` — Empty/zero-data state with title, description, optional action
- `AIInsightCard.tsx` — Highlighted AI signal card

### Improvements in this pass:
- `MetricCard`: add sparkline mini-chart in bottom-right corner
- `TopHeader`: add `welcomeText` prop for "Welcome back, Name!" caption above title
- `PageHeaderContext`: add `welcomeText` to `PageMeta` interface
- `index.css`: warm the table header tint from neutral gray to warm red-tinted surface

---

## Exact Color-Token Mapping (reference → token)

| Reference role | Token | Value |
|---|---|---|
| Sidebar background | `app-sidebar-DEFAULT` / gradient | `#65080A → #7A0B0D → #4D0507` |
| Sidebar active item | `app-sidebar-active` | `#B71920` |
| Primary CTA | `app-brand-700` | `#941216` |
| Primary CTA hover | `app-brand-800` | `#7A0B0D` |
| Canvas / page bg | `app-canvas` | `#F8F9FB` |
| Card surface | `app-surface` | `#FFFFFF` |
| Card border | `app-border` (border-app) | `#E8EAEE` |
| Table header bg | warm tint | `rgba(253,235,236,0.35)` |
| Success | `app-success` | `#15803D` |
| Warning | `app-warning` | `#D97706` |
| Danger | `app-danger` | `#DC2626` |
| Chart series 1 | `app-brand-700` | `#941216` |
| Chart series 2 | `app-brand-500` | `#D52B31` |
| Chart fail series | `app-warning` | `#D97706` |

---

## Migration Order (Phases)

### Phase 1 — Foundation (This file + CSS + shared components)
1. Create this file
2. Update `index.css` — table header warm tint
3. Update `PageHeaderContext.tsx` — add `welcomeText`
4. Update `TopHeader.tsx` — add `welcomeText` rendering
5. Update `MetricCard.tsx` — add sparkline prop

### Phase 2 — Shell
Already correctly styled. Minor TopHeader height/density improvements only.

### Phase 3 — Primary Screens
1. `Dashboard.tsx` — welcome text + sparkline data plumbing
2. `TestAssistant.tsx` — compact tab bar style
3. `TestCases.tsx` — Smart Assistant in right column (2-col grid)
4. `Settings.tsx` — tab icons
5. `Users.tsx` — welcome text + pagination + sparklines

### Phase 4 — Remaining Screens
1. `AuditLogs.tsx` — table toolbar visual polish
2. `Sessions.tsx` — status chip polish
3. `Login.tsx` — compact, polished card
4. Other pages as needed

### Phase 5 — Verification
- `npm run build` — fix all TypeScript/import errors
- Manually validate each route

---

## APIs, Routes, RBAC, Audit, Tokens, Uploads, Exports, and AI Behavior

**No backend behavior is changed in this implementation.** Specifically:
- API endpoint paths, HTTP methods, and payloads are unchanged
- Auth/session tokens, JWT handling, and refresh logic are unchanged
- RBAC permission checks and protected route guards are unchanged
- Audit log events (`logApiEvent`, `auditService`) are unchanged
- Token allocation and usage accounting are unchanged
- File upload/download handlers are unchanged
- Streaming generation fetch logic is unchanged
- Excel export logic is unchanged
- Knowledge Base chat sessions are unchanged
- All environment variables and secrets handling are unchanged

Only CSS class names, layout composition, and visual ordering of existing elements are modified.
