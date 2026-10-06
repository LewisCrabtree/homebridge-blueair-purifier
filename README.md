# Blueair Purifier (Lewis fork)

A personal fork of [kovapatrik/homebridge-blueair-purifier](https://github.com/kovapatrik/homebridge-blueair-purifier), retaining its Apache-2.0 license and upstream credits. Package identity: `@lewiscrabtree/homebridge-blueair-purifier`. Platform alias: `blueair-purifier`.

## Changes

- Cloud throttling (229/429) stops immediate retries and starts a shared client cooldown, honoring Retry-After. Failed authentication waits at least 15 minutes. Login refresh is single-flight and has a timeout.
- Polling has a 60-second minimum, backs off after failures, recovers from startup failures, and stops on shutdown. Reads and cloud writes share a lock. Slider values are buffered for 350 ms and only the last value is sent.
- Failed writes reject HomeKit handlers. Ambiguous writes are never automatically replayed. A successful cloud acknowledgement is reconciled by the next poll; it is not proof of physical application.
- AQI uses the current snapshot, caps values above the scale, and handles fractional PM10 correctly. Missing or invalid readings remain unavailable, not zero. The derived category is an instantaneous approximation, not an official regulatory AQI exposure measurement.
- Missing particulate readings can fall back to five-minute cloud history. Historical requests are cached for five minutes; sparse rows are searched per sensor. Fresh REST readings take precedence.
- Filter updates target FilterMaintenance. Replacement threshold means percentage USED. Unsupported sensors are omitted. PM1 is a custom characteristic for apps such as Eve/Controller; Apple Home may not display it.
- Manual fan control exits Night and Auto. Hardware reporting `nb_`/`high` uses a 0-91 raw range mapped to a 0-100% HomeKit slider. Physical steps and firmware behavior must be checked on the target device.
- Discovery respects the cloud-region override. Debug logging no longer prints credentials, environment variables, configuration objects, or token responses.

## Install

Use the `.tgz` attached to a GitHub release or the manual Actions package artifact. From the Homebridge terminal:

```sh
npm install --prefix /var/lib/homebridge --save --omit=dev /path/to/lewiscrabtree-homebridge-blueair-purifier-1.3.0-lewis.1.tgz
```

Alternatively, install a pinned Git commit (npm builds the TypeScript via the prepare script):

```sh
npm install --prefix /var/lib/homebridge --save --omit=dev github:LewisCrabtree/homebridge-blueair-purifier#COMMIT_SHA
```

Do not run this fork and the original plugin together: they intentionally share a platform alias. Use a separate child bridge. In plugin settings, Discover Devices, enter Blueair credentials, select the account region, add the purifier, and enable LED, Night Mode and Air Quality Sensor as desired. If authentication succeeds but discovery/control fails, set Cloud Region Override to the device-control region and discover again.

## Validation and limits

Pushes to main and pull requests run lint, TypeScript builds, and regression tests on Node 20, 22, and 24. The Package and release workflow repeats that matrix, builds an archive plus SHA256 checksum, and loads the production package to verify Homebridge registration. A manual run creates a downloadable Actions artifact. Pushing a `v` tag matching the package version also publishes a GitHub release; versions containing a hyphen are prereleases. Nothing is published to npm. Homebridge installations remain pinned to a chosen release URL and are updated deliberately after hardware checks.

```sh
npm ci --ignore-scripts
npm run lint -- --max-warnings=0
npm test
npm pack --ignore-scripts
```

Automated tests cover actual HAP services, sensor boundaries/missing data, failure propagation, concurrent writes, buffered controls, throttling, login coalescing, telemetry fallback and startup/shutdown recovery. Hardware acceptance requires HomeKit/app/device agreement for power, every physical fan level, Auto, Night, LEDs, child lock, particulate readings, filter status, and reconnection. Cloud telemetry can lag; this version uses REST and historical fallback, not MQTT push or local control. Blueair service outages and account-wide quotas still apply.

Before deployment, back up Homebridge's config and installed-package manifest outside this repository. Rollback consists of removing this scoped package and restoring the prior config/package installation. Never commit account credentials, device identifiers, or Homebridge backups.

## Supported Devices

This plugin only supports WiFi connected BlueAir purifiers utilizing cloud connectivity (via AWS) for device communication. The upstream plugin lists the following devices. This fork is being validated on a Blue Pure 211i Max; other models have regression tests but have not been tested on hardware here.

| Device | Product Page |
|----------------|------------|
| Blue Pure 211i Max | [link](https://www.blueair.com/us/air-purifiers/blue-pure-211i-max/3541.html?cgid=air-purifiers) |
| Blue Pure 311i+ Max | [link](https://www.blueair.com/us/air-purifiers/blue-pure-311i-plus-max/3540.html?cgid=air-purifiers) |
| Blue Pure 311i Max | [link](https://www.blueair.com/us/air-purifiers/blue-pure-311i-max/3539.html?cgid=air-purifiers) |
| Blue Pure 411i Max | [link](https://www.blueair.com/us/air-purifiers/blue-pure-411i-max/3538.html?cgid=air-purifiers) |
| Blue Pure 511i Max | [link](https://www.blueair.com/us/air-purifiers/blue-pure-511i-max/3710.html) |
| Protect 7470i | [link](https://www.blueair.com/us/air-purifiers/2954.html?cgid=air-purifiers) |
| DustMagnet™ 5440i | [link](https://www.blueair.com/us/air-purifiers/dustmagnet-5440i/2420.html?cgid=air-purifiers) |

### Features

- **Simple Login Mechanism** - all you need is your username and password to get started.
- **Semi-automatic detection and configuration of multiple BlueAir devices.**
- **Fast response times** - the plugin uses the BlueAir API to communicate with the devices.

>[!NOTE]
>**Air quality readings** - the plugin may not always report the correct air quality readings (like PM 2.5) due to the BlueAir API limitations. The solution for this issue is in progress.

## Plugin Configuration

### Feature Toggles
* Show LED service as a lightbulb
* Show Air Quality Sensor service
* Show Temperature Sensor service
* Show Germ Shield switch service
* Show Night Mode switch service

### Customizable Options
* Adjustable Filter Change Level
* Device Name
* Verbose Logging
* BlueAir Server Region Selection

### Supported Devices / Features
| Device                                                   | Air Purifier | LED Status Switch |    PM 2.5    | Temp. Sensor | Humidity Sensor | Night Mode | Germ Shield |
|----------------------------------------------------------|:------------:|:-----------------:|:------------:|:------------:|:---------------:|:----------:|:-----------:|
| DustMagnet                                               |      Y       |         Y         |      Y       |      N       |        N        |     Y      |      N      |
| HealthProtect                                            |      Y       |         Y         |      Y       |      Y       |        N        |     Y      |      Y      |
| Blue Pure                                                |      Y       |         Y         |      Y       |      N       |        N        |     Y      |      N      |

## Contribution

Help is always welcome. If you'd like to get involved, check out the [contribution notes](CONTRIBUTING.md).

## Credits
Inspired by the work of [@fsj21](https://github.com/fjs21) on the Amazon Web Services (AWS) API and construction of the documentation. Used part of the [blueair_api](https://github.com/dahlb/blueair_api) implementation as reference to mine. 

### Trademarks

Apple and HomeKit are registered trademarks of Apple Inc.
BlueAir is a trademark of Unilever Corporation
