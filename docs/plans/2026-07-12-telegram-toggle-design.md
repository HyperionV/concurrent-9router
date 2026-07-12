# Design Doc: Telegram Notifications Toggle

This design document outlines the changes to introduce a setting to enable or disable Telegram notifications in the Project Router.

## Purpose

Currently, if `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are configured in the environment variables, the system automatically sends connection status alerts (when connections deactivate) and periodic usage reports. There is no runtime toggle to temporarily or permanently silence these notifications without restarting the application or modifying environment variables.

We will add a persistent setting `telegramEnabled` (with UI alias `enableTelegram`) to SQLite settings, so it can be managed dynamically via the Dashboard.

## Proposed Changes

### 1. Database & Persistence Layer

- **`DEFAULT_SETTINGS` in `defaults.js`**:
  Add `telegramEnabled: true` to the default settings object.

- **`normalizeSettings` in `defaults.js`**:
  Normalize `enableTelegram` and `telegramEnabled` from UI or API calls:
  ```javascript
  if (typeof source.enableTelegram === "boolean") {
    next.telegramEnabled = source.enableTelegram;
  }
  if (typeof source.telegramEnabled === "boolean") {
    next.telegramEnabled = source.telegramEnabled;
  }
  ```

- **`withSettingsAliases` in `defaults.js`**:
  Add UI-friendly alias:
  ```javascript
  enableTelegram: settings.telegramEnabled === true
  ```

- **`app_settings` Schema in `runtime.js`**:
  Add `telegram_enabled INTEGER NOT NULL DEFAULT 1` to the table schema definition.
  Add `ensureColumn(db, "app_settings", "telegram_enabled", "INTEGER NOT NULL DEFAULT 1")` to the migration flow.
  Map `@telegramEnabled` in `seedDefaults` INSERT statement.

- **Mapping & Writing in `store.js`**:
  Map `telegramEnabled: fromBool(row.telegram_enabled)` in `mapSettingsRow`.
  Update `writeSettings` to persist `telegram_enabled` to database.

### 2. Backend Notification Gatekeeper

- **`sendTelegramMessage` in `src/lib/telegram.js`**:
  Check `telegramEnabled` setting:
  ```javascript
  const settings = await getSettings();
  if (settings && settings.telegramEnabled === false) {
    console.warn("[Telegram] Telegram notifications are disabled in settings.");
    return false;
  }
  ```

- **Manual Trigger Endpoint `/api/telegram/report`**:
  Check `telegramEnabled` and return a descriptive `400 Bad Request` if disabled, alerting the user immediately.

### 3. Frontend Dashboard Settings Page

- **`ProfilePage` in `src/app/(dashboard)/dashboard/profile/page.js`**:
  Add a Toggle switch for `telegramEnabled` inside the "Telegram Notifications" settings card.
  Add an `updateTelegramEnabled(enabled)` handler that sends a `PATCH` request to `/api/settings`.

## Verification & Testing

1. Run unit/integration tests (`npm run test:dispatcher`) to verify database bootstrapping and serialization.
2. Manually test toggling the setting on the dashboard.
3. Test triggering manual report while enabled and disabled.
