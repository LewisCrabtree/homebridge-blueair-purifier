# Proposed next steps

Status: MQTT, polling fallback, per-field sensor timestamps, stale-data expiry, shadow ordering and bounded command-report confirmation are implemented in 1.4.0-lewis.0. Live stream, TTL and natural token-expiry verification remain acceptance items. Target 211i discovery and particulate values are verified; the owner confirmed fan, LED and Night controls. Auto, physical fan-step mapping and child lock remain unverified on hardware.

## MQTT with polling fallback

The [blueair_api MQTT implementation and protocol notes](https://github.com/dahlb/blueair_api/blob/0e058e10d659e189fcf95c400d5dade021df07cd/docs/mqtt.md) document MQTT 3.1.1 over secure WebSockets to Blueair's AWS IoT broker. The existing cloud login response supplies a custom authorizer name, signature, and token. The same account connection can receive sensor batches, device-shadow reports, and connectivity events. This is cloud connectivity; it does not provide LAN control.

Use one MQTT connection per account, with endpoints chosen from the device-control region. Keep credentials in memory, use TLS certificate validation, and never log tokens or signed connection headers. A Node implementation can use [MQTT.js](https://github.com/mqttjs/MQTT.js) with [AWS custom authentication](https://docs.aws.amazon.com/iot/latest/developerguide/custom-auth.html). Add the dependency only when implementing and testing that transport.

Discovery and initial snapshots stay on REST. Commands stay on REST initially; MQTT reported state confirms application when available. A cloud acknowledgement alone still cannot prove that a purifier applied a command.

Implemented modes:

- `poll`: current REST-only behavior.
- `auto`: try MQTT when login supplies its credentials, use REST when unavailable, and return to push after recovery.
- A strict MQTT-only mode is unnecessary until hardware evidence establishes a reason for it.

While push is healthy, REST reconciliation uses at least 15 minutes. A sensor stream silent for 45 seconds restores configured polling (minimum 60 seconds), subject to shared cooldown/backoff. Every device must have fresh particulate messages before the account stream is considered healthy. No REST request is made for each MQTT message or buffered slider event. Sensor values expire after ten minutes. General release default remains polling-only; auto mode is selected explicitly for live acceptance.

## Lifecycle and data correctness

The reference implementation documents two separate lifetimes: login credentials expire after roughly 24 hours, while the five-second sensor stream typically stops after the configured `rt5s.ttl` (often 20 minutes). A socket can remain connected after sensor publishing stops. Re-subscribe before each device's TTL expires, without unsubscribing first; refresh credentials and rebuild authenticated connections before token expiry. Read actual TTL and sensor declarations from discovery instead of assuming every model matches the reference.

Add jittered reconnect backoff and one reconnection owner. Prevent concurrent login, reconnect, and polling loops. Cancel all timers, subscriptions, and pending commands on shutdown. Missing MQTT credentials should degrade cleanly to REST.

Merge partial reports by field. Preserve per-field source and timestamps, reject older shadow versions and out-of-order readings, validate values, and expire stale data explicitly. Historical REST readings must not overwrite newer push data. A broker disconnect describes transport health, not necessarily the purifier's online state; connectivity events can also be delayed.

Use MQTT reports for bounded command confirmation: match the expected state, time out honestly, and avoid resending an ambiguous REST write. Serialize multi-step mode/speed changes so an older report cannot undo a newer user request.

## Other useful improvements

- Redacted diagnostics: transport mode, last fresh reading, last successful reconciliation, cooldown remaining, and reconnect count.
- Capability-driven controls: verify the target hardware's fan range and actual physical steps, supported sensors, LED behavior, and Night/Auto transitions before offering additional controls.
- Restore the last manual speed and LED brightness predictably across Night, standby, and restarts where hardware supports it.
- Per-sensor freshness and fault reporting; retain filter-maintenance notifications and honest unknown values during outages.
- Use HomeKit automations for schedules and presence initially, avoiding a duplicate scheduling system inside the plugin.

## Acceptance gates

First finish the REST baseline on the actual 211i: power, each fan step, Auto, Night, LEDs, lock, filter state, sensor values, and bridge restart. Then test MQTT payload parsing and merging, duplicate/out-of-order messages, TTL renewal, token rotation, broker loss, fallback/recovery, throttling, and shutdown with deterministic fixtures. Run the real device beyond its sensor TTL and verify reported states against the app and physical purifier. Keep MQTT opt-in until those checks pass; label remaining live soak and natural token-expiry checks separately.

CI/CD already validates Node 20/22/24, lint, build, tests, and the packaged runtime. Tagged releases publish version-matched archives and checksums to this fork. Hardware deployment remains a deliberate release selection with a Homebridge backup and rollback path.
