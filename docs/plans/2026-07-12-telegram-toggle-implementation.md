# Telegram Notifications Toggle Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a setting to turn on/off Telegram messaging via database persistence, API integration, and settings dashboard UI.

**Architecture:** We will introduce a `telegramEnabled` boolean setting in the SQLite backend `app_settings` table (defaulting to `true`). The notifications module (`sendTelegramMessage`) and manual trigger endpoint `/api/telegram/report` will check this setting. A toggle switch will be placed in the Telegram Notifications card in the settings Dashboard UI.

**Tech Stack:** Next.js (App Router), React, SQLite (better-sqlite3)

---

### Task 1: SQLite Settings Schema and Mappers

**Files:**
- Modify: [defaults.js](file:///c:/Users/ADMIN/Desktop/Projects/Project%20Router/concurrent-9router/src/lib/sqlite/defaults.js#L3-L44) (add `telegramEnabled` default)
- Modify: [defaults.js](file:///c:/Users/ADMIN/Desktop/Projects/Project%20Router/concurrent-9router/src/lib/sqlite/defaults.js#L46-L115) (normalize and alias `telegramEnabled`)
- Modify: [runtime.js](file:///c:/Users/ADMIN/Desktop/Projects/Project%20Router/concurrent-9router/src/lib/sqlite/runtime.js#L117-L151) (add schema column `telegram_enabled`)
- Modify: [runtime.js](file:///c:/Users/ADMIN/Desktop/Projects/Project%20Router/concurrent-9router/src/lib/sqlite/runtime.js#L488-L540) (ensure column runs on existing db)
- Modify: [runtime.js](file:///c:/Users/ADMIN/Desktop/Projects/Project%20Router/concurrent-9router/src/lib/sqlite/runtime.js#L562-L661) (insert seed default settings)
- Modify: [store.js](file:///c:/Users/ADMIN/Desktop/Projects/Project%20Router/concurrent-9router/src/lib/sqlite/store.js#L44-L106) (map settings row from db)
- Modify: [store.js](file:///c:/Users/ADMIN/Desktop/Projects/Project%20Router/concurrent-9router/src/lib/sqlite/store.js#L116-L220) (update settings query to save `telegram_enabled`)
- Test: [sqlite-contract.test.mjs](file:///c:/Users/ADMIN/Desktop/Projects/Project%20Router/concurrent-9router/tests/dispatcher/sqlite-contract.test.mjs)

**Step 1: Write the failing test**
Update `tests/dispatcher/sqlite-contract.test.mjs` to assert `telegramEnabled` default value is `true` and can be successfully toggled to `false` and persisted.

**Step 2: Run test to verify it fails**
Run: `npm run test:dispatcher`
Expected: FAIL due to missing property or SQLite column errors.

**Step 3: Write minimal implementation**
Implement the modifications to `defaults.js`, `runtime.js`, and `store.js` as detailed in the design.

**Step 4: Run test to verify it passes**
Run: `npm run test:dispatcher`
Expected: PASS

**Step 5: Commit**
```bash
git add src/lib/sqlite/defaults.js src/lib/sqlite/runtime.js src/lib/sqlite/store.js tests/dispatcher/sqlite-contract.test.mjs
git commit -m "feat: add telegramEnabled sqlite settings and persistence schema"
```

---

### Task 2: Core Notification Guard and manual route check

**Files:**
- Modify: [telegram.js](file:///c:/Users/ADMIN/Desktop/Projects/Project%20Router/concurrent-9router/src/lib/telegram.js) (check `telegramEnabled` in `sendTelegramMessage`)
- Modify: [route.js](file:///c:/Users/ADMIN/Desktop/Projects/Project%20Router/concurrent-9router/src/app/api/telegram/report/route.js) (return `400` error if manual trigger is disabled in settings)

**Step 1: Write the failing test / mock check**
Add a test in `sqlite-contract.test.mjs` or similar to verify `sendTelegramMessage` returns `false` and doesn't trigger the API call when `telegramEnabled` is set to `false`.

**Step 2: Run test to verify it fails**
Run: `npm run test:dispatcher`
Expected: FAIL

**Step 3: Write minimal implementation**
Modify `telegram.js` and `/api/telegram/report/route.js`.

**Step 4: Run test to verify it passes**
Run: `npm run test:dispatcher`
Expected: PASS

**Step 5: Commit**
```bash
git add src/lib/telegram.js src/app/api/telegram/report/route.js tests/dispatcher/sqlite-contract.test.mjs
git commit -m "feat: enforce telegramEnabled checks in sender and api route"
```

---

### Task 3: Dashboard Profile Settings Toggle UI

**Files:**
- Modify: [page.js](file:///c:/Users/ADMIN/Desktop/Projects/Project%20Router/concurrent-9router/src/app/%28dashboard%29/dashboard/profile/page.js) (add toggle and patch handler)

**Step 1: Write UI updates**
Insert the toggle component at the top of the Telegram card, wire it to the settings fetched state and `updateTelegramEnabled` callback.

**Step 2: Run local server and check UI**
Build and verify the dashboard profile page UI layout is clean and consistent.

**Step 3: Commit**
```bash
git add src/app/\(dashboard\)/dashboard/profile/page.js
git commit -m "feat: add telegram notifications toggle in profile page UI"
```
