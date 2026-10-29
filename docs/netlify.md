# Netlify deployment

This site now uses the standalone frontend in `netlify-web/` and the server-side
functions in `netlify/functions/`. It does not require a Python server or a
WebSocket host for its implemented chat workflow.

The Netlify configuration pins Node.js 22, runs `npm run build:netlify`, and
publishes `build/`. The package requires Node.js 22.12 or later within the 22
release line. The original Python application and Svelte frontend remain in the
repository; their original build and check scripts are separate from this deploy.

The implemented workflow includes Netlify Identity login, signup confirmation,
password recovery and invitation handling; private conversations stored in
Netlify Database; server-side AI replies through Netlify AI Gateway; conversation
renaming, deletion, export, and reopening; sanitized Markdown; and a responsive
Bengali interface. Open WebUI branding and license assets were retained.

The schema is defined in `db/schema.ts`. A generated migration was included in
`netlify/database/migrations/`; Netlify applies it during deployment. Identity
activation was requested with the platform activation script. API calls require
an authenticated user, and conversation reads and mutations are scoped to that
user. AI calls stay server-side. The production SPA fallback is in
`netlify-web/public/_redirects` and is copied into the publish directory.

## Local verification

Run `netlify dev --port 8889`, then use:

- `npm run check:netlify` for strict checking of the deployed frontend and API.
- `npm run test:netlify` for API boundary and turn-lifecycle tests.
- `npm run test:netlify:browser` for Chromium interface tests with intercepted
  Identity and API services. Install the Playwright Chromium browser first if it
  is not already available.

The new strict type check, 13 API tests, and 4 browser tests passed. Browser tests
covered sign-in validation, chat creation and reopening, renaming, exporting,
deletion, safe Markdown, retry behavior, signup confirmation messaging, password
recovery messaging, and mobile navigation. Those tests used isolated service
fixtures and did not establish live Identity accounts or contact an AI provider.

## Remaining validation and scope

Production build validation, migration application, Identity activation, and live
AI replies still require the platform deployment. In the local environment,
unauthenticated chat requests returned 401 and `/api/health` returned 503 because
the new database schema was not yet applied. Live account confirmation, recovery
emails, persisted conversation round trips, and provider replies were not
verified end to end.

The original Open WebUI feature set was not fully ported. Python-dependent
features such as local Ollama hosting, document retrieval, tools, channels, and
its original administration system are not exposed by this standalone frontend.
Existing errors in the original application's type check remain; the last check
reported 4,433 errors and 188 warnings. They were not suppressed, and the original
check command was retained. The standalone Netlify application passed its own
strict type check.
