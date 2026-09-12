# Backlog — Panasonic Aquarea (Community)

Findings from the code review of 2026-09-12. Line numbers refer to that state of
the tree (branch `language`, at cd3a1e4).

Status: `todo` / `wip` / `done` / `wontfix`

---

## P0 — live user-facing breakage

### BUG-1 · Convector can never re-authenticate `todo`
`drivers/aquarea_convector/driver.js:63-67` stores only `macAddress` + `session`.
`drivers/aquarea_convector/device.js:61-62` reads `store.email` / `store.password`
— both `undefined`. Once the JWT expires, `login()` can never succeed.

Worse: the re-login path that exists (`lib/AquareaHomeClient.js:434-440`) hangs off
the REST `_request`, but polling uses gRPC (`getDeviceStatus`), which has no re-auth
at all. Device goes unavailable permanently; only fix is delete + re-pair.

**Fix:** persist credentials in the store like `aquarea_heatpump` does, and map gRPC
status `16` (UNAUTHENTICATED) to `login()` + one retry.
**Note:** existing paired convectors have no credentials in their store — needs a
repair flow (see FEAT-2) or a clear "re-pair once" changelog entry.

### BUG-5 · Dutch translation erased at runtime `todo`
`_applyRanges` hardcodes `{ en, fr }` only — `drivers/aquarea_heatpump/device.js:525-531`
(zone label) and every `meter_power.*` / `measure_cost.*` title at `:565-620`.
`app.json` has proper `nl` strings, but these `setCapabilityOptions` calls overwrite
them. NL users see English on exactly the tiles that matter most.

**Fix:** route through `this.homey.__()` with keys in `locales/*.json` — the pattern
already used correctly in `_updateInfoSettings`.

---

## P1 — correctness and robustness

### BUG-2 · Convector leaks its poll timer `todo`
No `onUninit()` (heat pump has one at `drivers/aquarea_heatpump/device.js:1057`).
Also `onInit` awaits `_initClient()`, which can throw on a bad login, leaving the
device half-initialised with no capability listeners registered.

### BUG-3 · Convector flaps unavailable on any network blip `todo`
`drivers/aquarea_convector/device.js:147` calls `setUnavailable(err.message)` on every
poll error, including a transient timeout. The heat pump deliberately stays available
except on persistent auth failure (`drivers/aquarea_heatpump/device.js:369-373`).

**Fix:** one shared policy — N consecutive failures before going unavailable.

### BUG-4 · Auth detection by regex over a partly-French message `todo`
`drivers/aquarea_heatpump/device.js:371` does
`/identifiants|invalid|2FA|authorization code|access token/i.test(err.message)`.
`AquareaError` already carries `.code` — use it.

Related: thrown messages mix French and English (`lib/AquareaClient.js:395`, `:401`,
`:589`) and surface in `setUnavailable()`, so an EN/NL user sees
"identifiants invalides ou 2FA ?" in the UI.

### BUG-6 · `_syncCapabilities` wipes Insights history `todo`
`drivers/aquarea_heatpump/device.js:213-242` removes and re-adds *every* capability
whenever the desired list or order differs. Any future tweak to
`_desiredCapabilities` ships as a release that silently destroys all users'
historical data and can break saved Flows.

**Fix:** apply only the add/remove diff and accept imperfect tile order, or gate
reorders behind a one-time migration key (pattern exists: `device_class_heater_v1`).
**Do this before the next capability change** — it is cheap now, expensive later.

### BUG-7 · `meter_power.*` holds a value that resets daily `todo`
`_pollConsumption` (`drivers/aquarea_heatpump/device.js:388-396`) writes *today's* kWh
into `meter_power.heat/.cool/.tank`. Homey defines `meter_power` as a cumulative
meter: the midnight reset is a sawtooth in Insights, and reads as a negative delta
if Homey ever picks it up for the Energy tab.

**Fix:** daily figure on a custom capability; add a genuinely cumulative `meter_power`
accumulated app-side. Breaking change to existing Insights data — needs a migration plan.

### BUG-8 · Small stuff `todo`
- `setStoreValue('session', …)` runs every poll (`drivers/aquarea_heatpump/device.js:365`)
  — ~288 disk writes/day/device. Only write when `exportSession()` actually changed.
- `AquareaClient.setMode()` (`lib/AquareaClient.js:961`) and `setTargetTemperature()`
  (`:899`) each do an extra `getDeviceData()` round-trip before writing, doubling the
  API cost of every mode change. The device already has fresh data — pass it in.
- `package.json` says `1.0.0`, `app.json` says `1.1.3`.

---

## P1 — monitoring

### MON-1 · No fault-code handling anywhere `todo`
No `alarm_*`, no `setWarning`, no `createNotification` in the tree. When the heat pump
faults, the app is silent. `getDeviceData` returns `raw` and nothing ever reads it.

**Fix:** dump a real payload with `scripts/dump.js`, look for `errorStatus` /
`pendingErrorCode`-style fields, expose `alarm_generic` + a trigger card.
Highest-value single addition. (The convector once had `alarm_generic` and it was
removed as experimental — `drivers/aquarea_convector/device.js:37`.)
**Blocked on:** a real payload sample.

### MON-2 · No app self-monitoring `todo`
`info_last_update` is a label; nothing alarms on staleness. Add a consecutive-failure
counter and a "heat pump unreachable for X minutes" trigger card.

### MON-3 · No backoff on rate-limiting `todo`
`lib/AquareaClient.js:588` throws on 429 and the poller retries at the same cadence
forever — which is how accounts get locked out. Add exponential backoff with jitter on
429/5xx, surface via `setWarning`.

### MON-4 · One OAuth session per device `todo`
Each `AquareaDevice` builds its own `AquareaClient`. Aquarea Smart Cloud allows a
single active session per account (per `drivers/aquarea_heatpump/driver.js:11-14`), so
two paired devices are two sessions fighting each other and doubling login attempts
toward a lockout.

**Fix:** move the client to app level, keyed by username, and share it.

### MON-5 · No `measure_power` `todo`
Nothing instantaneous at all. `getConsumptionToday` already fetches `historyDataList`
with an hourly breakdown and then sums it away — keep the last complete hour and
publish average watts. Gives the Homey Energy tab something real.

### MON-6 · Defrost counting `todo`
`defrost_active` exists; count rising edges per day into `defrost_count_today`.
A climbing defrost rate is the earliest warning of an outdoor unit going bad, and it
costs no extra API calls.

---

## P2 — functionality

### FEAT-1 · Multi-zone as a first-class citizen `todo`
`data.zones` and `_zoneIds` are collected and Flow cards can *write* zone 2, but there
is no capability feedback for it, and `flowAdjustZoneSetpoint` must refuse secondary
zones for lack of a reference value (`drivers/aquarea_heatpump/device.js:938-941`).

**Fix:** zone-2 capabilities when `zoneCount > 1`, or pair each zone as its own device.

### FEAT-2 · `onRepair` flow `todo`
A changed password currently means delete + re-pair, losing all Insights history.
~30 lines. Also the migration path for BUG-1.

### FEAT-3 · COP `todo`
The metric owners actually care about. kWh in is available; heat out is not. Check the
raw payload for inlet/outlet water temperatures — if present, expose them plus ΔT.
Even without flow rate, ΔT against outdoor temperature is the core diagnostic for
short-cycling and undersizing.
**Blocked on:** a real payload sample.

### FEAT-4 · Monthly / yearly consumption `todo`
`dataMode` 1/2 on the endpoint already being called.

### FEAT-5 · Convector parity `todo`
No optimistic commit and no post-command refresh, unlike the heat pump — set the fan
speed and the UI bounces back on the next 60 s poll. Reuse `_commit` / `_refreshSoon`.

Also: every poll opens a fresh HTTP/2 connection (`lib/AquareaHomeClient.js:352`, `:378`)
at a 60 s default with a 30 s floor, far more aggressive than the heat pump's 300 s.
Reuse the session, or raise the floor.
