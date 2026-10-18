# Hydra Launcher — GulidovAlexander fork

Electron launcher (main / preload / renderer / big-picture). It is a fork of
entitybtw/hydra, which itself forks hydralauncher/hydra. What the fork adds is
**self-hosted mode**: the launcher uses your own `hydra-selfhosted` server for
accounts, library, achievements and cloud saves. Upstream sync steps are in
`../CLAUDE.md`.

Upstream code conventions (logger instead of console, i18n for every UI string,
`T[]` instead of `Array<T>`, short comments):
@.cursorrules

## Commands

```bash
yarn install --ignore-scripts   # local: skips the Rust/C++ native build
yarn typecheck                  # node + web tsconfig
yarn test                       # node --test over src/**/*.test.ts
npx eslint <files>              # `yarn lint` runs with --fix over the whole repo
npx prettier --check <files>
yarn dev                        # needs the full install (native addon)
```

Releases come from GitHub Actions (`.github/workflows/release.yml`). The tag is taken
from the `version` field in `package.json`, and the job needs `contents: write`. The
auto-updater feed points at this fork: `owner: "GulidovAlexander"` in
`src/main/index.ts`. Keep that line through every upstream merge.

## Fork features (carry these through every upstream sync)

- **Request routing** — `src/main/services/hydra-api.ts`: `selfHostedConfig`,
  `getInstanceForUrl` / `getAxiosConfig(url)` / `isOfficialOnlyUrl` send each request
  either to the self-hosted server or to the official API. The `useSelfHosted*` flags
  pick which features go to the self-hosted server. `validateOptions` skips official
  auth and subscription checks in self-hosted mode. A 401 from the self-hosted server
  must not sign the official account out.
- **Auth context identity** — upstream gates library/achievement work on
  `HydraApi.getAuthContext()`. While a self-hosted session is active, the context
  belongs to the self-hosted user: `resolveAuthIdentity()` reads `sub` from the
  self-hosted JWT, and `syncAuthContextIdentity()` runs on every self-hosted config
  change. Without this, achievement sync and resets silently stop in self-hosted mode.
- **Sign-in / sign-out** — an official sign-in during a self-hosted session must not
  clear `remoteId`s. `events/auth/sign-out.ts` keeps the local library when
  self-hosted is active. `setupApi` uploads the library on startup when a self-hosted
  user token is present.
- **Realtime** — `SSEClient.connect()` does nothing in self-hosted mode (the server has
  no stream and no chat).
- **Self-hosted auth flow** — `events/auth/self-hosted-sign-in.ts`, the
  `hydra-self-hosted://token/…` deep link and the Linux `.desktop` handler in
  `src/main/index.ts`, plus the renderer pages `self-hosted-auth/` and
  `settings/settings-self-hosted.tsx`.
- **Artwork** — SteamGridDB search and fallback (`searchSteamGridDb`,
  `use-game-artwork-grid.ts`, big-picture `customization-tab.tsx`). `get-game-assets.ts`
  fills missing art. `get-library.ts` prefetches missing or stale assets in the
  background.
- **Steam** — launch via the `steam://rungameid` URI (`launchViaSteam`). The process
  watcher tracks those launches through `steamAppIds`, collected in the native-addon
  worker.
- **Cloud saves** — per-game and global preference for v1 (server backup) or v2
  (`cloudSavesVersion`). Restore falls back to copy+unlink on `EXDEV` and removes stray
  files that are not in the backup.
- Library sync payloads include `title`; the self-hosted server needs it.
- entitybtw's own achievement notification window (`WindowManager.notificationWindow`),
  not upstream's presenter.

## Pitfalls

- Do not bring back a persisted `gameAchievements` sublevel. Upstream's
  `clearLegacyAchievementPersistence()` wipes that key on every startup, so it would
  only duplicate `AchievementMemoryStore`. It was removed in the 2026-10 sync.
- `NativeAddon.getSystemProcessMap()` must resolve `null` on failure. The process
  watcher skips the tick on `null`; an empty map would end every running session.
- Many upstream tests stub a module's dependencies strictly ("Unexpected dependency …"
  or a missing export). When a fork feature adds an import to an upstream module, add
  a stub to that module's test. Do not drop the feature.
- Without self-hosted, `getInstanceForUrl` must return `this.instance`. That instance
  carries the token-redacting log interceptors; `officialInstance` does not.

## Test baseline on this Windows machine

About 31 tests fail on unmodified upstream code too: symlink creation needs admin
rights (`EPERM`), the Epic/legendary binaries are missing, and some Epic Windows
job-object tests fail. `umu-launch-monitor.test.ts` is flaky under full-suite load.
Compare against upstream before you treat a failure as a regression.
