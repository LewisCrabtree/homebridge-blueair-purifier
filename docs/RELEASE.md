# Blueair Purifier (Lewis) 1.4.0

Adds optional cloud MQTT updates to the Blueair Homebridge fork, with polling fallback and safeguards for stale sensor data and cloud failures.

- Live particulate and device-state updates, stream renewal, credential rotation and reconnect backoff. Enable `transportMode: "auto"`; default remains polling.
- PM1, PM2.5 and PM10 support where reported by the device. PM1 uses a custom HomeKit characteristic.
- Per-field timestamps prevent older history or REST data from replacing fresh readings; stale particulate readings expire.
- Background command-report confirmation, buffered fan controls, shared throttling/backoff and no automatic replay of ambiguous writes.
- Correct filter maintenance, air-quality calculations and persistence of disabled configuration options.

Validated on a Blue Pure 211i Max: live updates at roughly five-second intervals, forced reconnect in about six seconds, accelerated stream renewal, LED report confirmation and restoration, and Homebridge PM2.5/PM10 readings without a sensor fault. The owner confirmed fan, LED and Night Mode controls.

CI checks Node 20/22/24, lint, build, 41 regression tests and production package registration. Assets include the installable `.tgz` and its SHA256 checksum. Nothing is published to npm.

Normal 20-minute stream renewal and natural 24-hour credential-expiry soaks remain unverified, as do physical Auto mode, child lock and exact fan-step mapping. Both MQTT and REST depend on Blueair's cloud. See README and docs/ENHANCEMENTS.md for installation and validation details.
