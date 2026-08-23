# Signal K embedded webapp — researched contract

Notes gathered while building the M1b panel. Source:
[`SignalK/signalk-server` `docs/develop/webapps.md`](https://github.com/SignalK/signalk-server/blob/master/docs/develop/webapps.md).

The upstream doc carries its own caveat — _"the documentation regarding embedded
WebApps and Components ... is rudimentary and should be considered under
development as the concept is evolving"_ — so treat this as a snapshot and
re-check it against the shared `plugin-ci` workflow, which validates the parts
that matter.

## 1. Keywords

| Keyword                     | Meaning                                                       |
| --------------------------- | ------------------------------------------------------------- |
| `signalk-webapp`            | standalone webapp, served on its own route                    |
| `signalk-embeddable-webapp` | a panel embedded in the admin UI — **what this plugin ships** |

A third case looks like a contradiction but is not: a package providing _only_
embedded components — no webapp of its own — also uses `signalk-webapp`, because
upstream defines no keyword for that case. Quoting the source: _"There is no
keyword for a module that provides only embedded components, use
`signalk-webapp` instead."_ Neither applies here: this package is a plugin that
ships an embeddable panel, so it uses `signalk-embeddable-webapp`.

## 2. Mechanism: Module Federation

Panels are loaded with [Module Federation](https://module-federation.io/) and
`React.lazy`. The exposed module names are **fixed** — the server looks for
these exact strings:

| Exposed name                 | Purpose                            |
| ---------------------------- | ---------------------------------- |
| `./AppPanel`                 | embeddable webapp panel — **ours** |
| `./PluginConfigurationPanel` | a custom plugin configuration form |
| `./AddonPanel`               | an embedded component              |

Each exposed module must `export default` a React component.

## 3. Webpack container

The admin UI loads the container with a classic `<script>` tag, so it must land
on `window` under a name derived from the package name:

```js
const containerName = packageJson.name.replace(/[-@/]/g, '_'); // signalk_portainer
library: { type: 'var', name: containerName }
```

Verify after building — `public/remoteEntry.js` should begin `var signalk_portainer`.

ESM containers from Vite/Rollup/esbuild are also supported (`export { init, get }`,
with `"type": "module"` in package.json), but then a CommonJS server side needs
`main` renamed to `.cjs`. We use the webpack `var` form and stay CommonJS.

## 4. React must be the host's instance

The admin UI runs **React 19**. Bundling a second copy fails at runtime with:

```text
Cannot read properties of null (reading 'useState')
```

because the panel's hooks read a dispatcher the host never activated. Declaring
React a singleton makes webpack's federation runtime use the host's share scope:

```js
shared: {
  react: { singleton: true, requiredVersion: '^19' },
  'react-dom': { singleton: true, requiredVersion: '^19' },
  'react/jsx-runtime': { singleton: true, requiredVersion: '^19' },
}
```

`react/jsx-runtime` is not optional. Module Federation matches share keys by the
exact request, so sharing `react` does not cover it, and the automatic JSX
runtime every modern build uses imports it on every file with JSX. Leave it out
and the panel builds its elements with its own bundled React while its
components run on the host's — which works only for as long as the two agree on
the element symbol. React 19 renamed it, so a host on React 18 rejects every
element the panel produces.

ESM bundlers instead alias `react` to shims re-exporting `window.__SK_REACT__`
and friends. Not applicable here.

## 5. Styling

`@signalk/server-admin-ui-dependencies` pins the dependencies the admin UI uses,
including `reactstrap`. This panel uses plain Bootstrap class names on ordinary
elements rather than importing `reactstrap`: the admin UI already loads the
Bootstrap CSS, so the styling matches without adding a second component library
to the federation share scope.

## 6. Authentication — why the facade design works

Signal K uses **cookie-based shared sessions**. The session cookie is an
HttpOnly JWT, so panel JavaScript cannot read it, and does not need to: a
`fetch` with `credentials: 'include'` has it attached automatically. Cookies
also ride along on the WebSocket opening request, so a future SSE or WebSocket
feature inherits the same session.

Token-based sessions are explicitly discouraged upstream because every login
overwrites the shared cookie, causing session confusion between webapps.

This is what makes the plugin's own facade under
`/plugins/signalk-portainer/api/*` the right place for Portainer access: the
panel is authenticated as the Signal K user with no token handling of its own,
and the Portainer credential never leaves the server.

## 7. Panel props

The admin UI passes properties into an embedded panel: login status, a way to
render a login form instead of content, get/set application data, an
auto-reconnecting WebSocket, and `get` for Signal K data. Reference
implementation:
[`Embedded.tsx`](https://github.com/SignalK/signalk-server/blob/master/packages/server-admin-ui/src/views/Webapps/Embedded.tsx).

This panel does not use them yet — it reads only from the plugin facade — but
they are the route to login handling and live Signal K data later.

## 8. App icon

`signalk.appIcon` in package.json names the image the server shows for this
package. PNG or SVG; upstream asks for at least 128×128 square. Without one the
admin UI draws a monogram from the package name instead.

```json
"signalk": {
  "displayName": "Portainer",
  "appIcon": "logo.svg"
}
```

The path is **relative to the directory the server mounts for the package**,
which is `public/` when the package ships one and the package root otherwise
([`local-assets.ts`](https://github.com/SignalK/signalk-server/blob/master/src/appstore/local-assets.ts)).
This package ships `public/`, so `logo.svg` there is what the webapp list
requests as `/signalk-portainer/logo.svg` — a declared `public/logo.svg` would
be looked for at `public/public/logo.svg` and 404.

That is the whole reason for `EmitAppIcon` in `webpack.config.js`: `public/` is
webpack's output directory and `output.clean` empties it on every build, so the
icon cannot be committed there. It lives in `assets/`, and the build emits a
copy alongside `remoteEntry.js`.

The App Store reads the same field, but resolves it **package-relative** against
jsdelivr rather than against the mount. A declared `logo.svg` is not at the
tarball root, so that lookup misses and the server's icon probe retries under
`public/`, `assets/`, `img/`, `docs/`, `dist/` and `src/` with the basename
([`icon-probe.ts`](https://github.com/SignalK/signalk-server/blob/master/src/appstore/icon-probe.ts))
— the first of which hits. Both copies are in the tarball, so neither path
depends on the probe alone.
