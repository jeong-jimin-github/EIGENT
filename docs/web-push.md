# Web Push and background notifications

EIGENT agent runs are owned by the server, not by the browser SSE request. Closing or backgrounding the PWA therefore does not stop an accepted run. Web Push is used only to bring the user back when the run finishes or needs attention.

## Self-host configuration

Generate a VAPID key pair once and keep the private key on the server:

```sh
bunx web-push generate-vapid-keys
```

Set these environment variables before starting `apps/server`:

```env
EIGENT_VAPID_PUBLIC_KEY=...
EIGENT_VAPID_PRIVATE_KEY=...
EIGENT_VAPID_SUBJECT=mailto:you@example.com
```

`EIGENT_PUSH_STORE` can override the durable subscription/mapping file. By default it is stored below `EIGENT_DATA_DIR` (or the normal EIGENT data directory). Never expose the VAPID private key to the browser.

Web Push requires a secure context: use HTTPS in production. `localhost` remains a browser-supported development exception.

## Client behavior

Open **Settings → Notifications** in the web/PWA build and enable **Web Push**. Each browser endpoint is stored once; subscribing again updates its category preferences instead of creating a duplicate. Categories are completion, failure, permission, question, and reconnect warnings.

Push notifications use a stable event tag so duplicate deliveries for the same run/request collapse in the browser. Clicking a notification focuses an existing EIGENT window when possible or opens the PWA, then deep-links to the visible chat session associated with the server-side agent session.

## Mobile / iOS PWA checklist

On iOS/iPadOS 16.4 or newer, Web Push is available to web apps installed on the Home Screen. Serve EIGENT over HTTPS, install it using **Add to Home Screen**, open the installed app, and enable Web Push from EIGENT settings. Verify that a long task continues after leaving the app and that completion/attention notifications reopen the matching chat.

Desktop Chromium/Edge and other standards-compatible browsers can subscribe directly from the web app. Browser/OS notification permission must remain enabled.
