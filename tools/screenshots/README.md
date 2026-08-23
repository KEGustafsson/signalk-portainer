# Taking the screenshots

The images in [`docs/images/`](../../docs/images) are captures of the real
plugin in a real Signal K admin UI. Nothing is drawn, composited or edited
afterwards. The only thing standing in for something else is Portainer:
`mock-portainer.js` answers the parts of the Portainer 2.x API the plugin calls,
with a plausible boat behind it — a Signal K server, InfluxDB, Grafana, an MQTT
broker, a stopped backup job and a container stuck restarting, on a Portainer
that also manages a shore NAS and an edge agent that is not checking in.

That is also the honest reading of the images: they show what the panel does
with a Portainer that answers as documented, which is not the same as one that
answers the way some particular version of it really does. Nothing here has been
pointed at a real Portainer.

## What you need

- The plugin built and installed into a Signal K server (Node 22+), with
  security off or a browser session already logged in.
- [Playwright](https://playwright.dev/) with Chromium, for the capture script:
  `npm install --no-save playwright && npx playwright install chromium`.

## Running it

Two fixture Portainers, so the panel's **Instance** selector has both a boat and
a shore to choose between. That selector is what a second Portainer adds to the
panel — configure one and it is not rendered at all — so a capture run with a
single instance produces a header one control shorter than these images show:

```bash
node tools/screenshots/mock-portainer.js 9500 boat &
node tools/screenshots/mock-portainer.js 9501 shore &
```

Then configure the plugin against them — in the admin UI, or by writing
`plugin-config-data/signalk-portainer.json` in the Signal K configuration
directory:

```json
{
  "enabled": true,
  "configuration": {
    "instances": [
      {
        "name": "boat",
        "enabled": true,
        "url": "http://127.0.0.1:9500",
        "authMode": "apiKey",
        "apiKey": "ptr_screenshotfixture"
      },
      {
        "name": "shore",
        "enabled": true,
        "url": "http://127.0.0.1:9501",
        "authMode": "apiKey",
        "apiKey": "ptr_screenshotfixture",
        "environmentName": "nas"
      }
    ],
    "telemetry": { "level": "health", "intervalSeconds": 30, "pathPrefix": "system.docker" },
    "control": {
      "allowPutControl": true,
      "allowDestructive": false,
      "allowSelfManagement": false,
      "watchdog": [
        { "container": "influxdb", "instance": "boat" },
        { "container": "mosquitto", "instance": "boat" }
      ]
    }
  }
}
```

The first server deliberately has no environment named: the capture presses one
in the panel, which is the flow the screenshots document, and the plugin writes
`environmentId` back into this file itself. The second one names `nas` so that
switching instance does not land on another question. `allowDestructive` stays
off on purpose: a disabled Remove button carrying the setting that would enable
it is part of what the screenshots are showing.

With the server up, capture:

```bash
node tools/screenshots/capture.mjs                       # into docs/images
node tools/screenshots/capture.mjs --out /tmp/shots      # somewhere other than docs/
```

`--server` defaults to `http://127.0.0.1:3000` and the script refuses any
address that is not loopback, because of what it writes (below): pointed at a
boat it would overwrite the plugin options that boat is running on. A
throwaway server on another host can be captured with
`--server http://host:3000 --allow-remote-writes`, which is the acknowledgement
that its plugin configuration is expendable.

The script drives the admin UI the way a person would — pressing an environment
row to choose it, clicking through the tabs, opening the log viewer with Follow
on, typing commands into the console, opening a stack — and crops each shot to
the part of the window that matters. The data browser shot waits for the delta
poller to publish, which can take a whole poll interval.

**It writes to the plugin's configuration**, through the same Signal K API the
admin UI saves from, twice. First it clears the chosen environment, because the
panel writes that choice back the moment a row is pressed: without clearing it
the first-run state would exist exactly once, and every later run would
photograph the after picture twice. Then, once the panel has chosen one again,
it saves the options unchanged — a plain restart, which is what clears the
error the plugin reported while it had no environment, so the configuration page
is photographed showing the steady state rather than the tooling's own mess.
Point it at a fixture server, not at anything you care about.

## When a screenshot needs redoing

Change what the panel renders and the images go stale. Re-run the capture rather
than editing an image: everything in them comes from the fixture and the panel,
so a rebuilt plugin and a fresh run is the whole update. Keep the file names —
the README links to them by name.
