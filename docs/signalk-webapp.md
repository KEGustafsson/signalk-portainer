# Signal K embedded webapp — researched contract

Notes gathered while building the M1b panel. Source:
[`SignalK/signalk-server` `docs/develop/webapps.md`](https://github.com/SignalK/signalk-server/blob/master/docs/develop/webapps.md).

The upstream doc carries its own caveat — *"the documentation regarding embedded
WebApps and Components ... is rudimentary and should be considered under
development as the concept is evolving"* — so treat this as a snapshot and
re-check it against the shared `plugin-ci` workflow, which validates the parts
that matter.

## 1. Keywords

| Keyword | Meaning |
| --- | --- |
| `signalk-webapp` | standalone webapp, served on its own route |
| `signalk-embeddable-webapp` | a panel embedded in the admin UI — **what this plugin ships** |

A third case looks like a contradiction but is not: a package providing *only*
embedded components — no webapp of its own — also uses `signalk-webapp`, because
upstream defines no keyword for that case. Quoting the source: *"There is no
keyword for a module that provides only embedded components, use
`signalk-webapp` instead."* Neither applies here: this package is a plugin that
ships an embeddable panel, so it uses `signalk-embeddable-webapp`.

## 2. Mechanism: Module Federation

Panels are loaded with [Module Federation](https://module-federation.io/) and
`React.lazy`. The exposed module names are **fixed** — the server looks for
these exact strings:

| Exposed name | Purpose |
| --- | --- |
| `./AppPanel` | embeddable webapp panel — **ours** |
| `./PluginConfigurationPanel` | a custom plugin configuration form |
| `./AddonPanel` | an embedded component |

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
}
```

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
