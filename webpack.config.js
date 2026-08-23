const fs = require('fs');
const path = require('path');
const { Compilation, sources } = require('webpack');
const { ModuleFederationPlugin } = require('webpack').container;
const packageJson = require('./package.json');

// The app icon has to arrive in `public/`: that is the directory the Signal K
// server mounts for this package, and `signalk.appIcon` in package.json is
// resolved against it. `output.clean` empties `public/` on every build, so the
// icon cannot simply be committed there — it is emitted from `assets/`, which
// stays the one copy anything else (the README, npm) can point at.
const APP_ICON_SOURCE = path.resolve(__dirname, 'assets/logo.svg');

class EmitAppIcon {
  constructor(name) {
    this.name = name;
  }

  apply(compiler) {
    compiler.hooks.thisCompilation.tap('EmitAppIcon', (compilation) => {
      compilation.hooks.processAssets.tap(
        {
          name: 'EmitAppIcon',
          stage: Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
        },
        () => {
          // Declared as a dependency so `--watch` re-emits when it is edited.
          compilation.fileDependencies.add(APP_ICON_SOURCE);
          compilation.emitAsset(this.name, new sources.RawSource(fs.readFileSync(APP_ICON_SOURCE)));
        },
      );
    });
  }
}

// The Signal K admin UI loads the container with a classic <script> tag, so the
// container has to land on `window` under a name derived from the package name.
const containerName = packageJson.name.replace(/[-@/]/g, '_');

module.exports = {
  mode: 'production',
  // Module Federation container only — there is no standalone entry point.
  entry: {},
  output: {
    path: path.resolve(__dirname, 'public'),
    publicPath: 'auto',
    clean: true,
    // Chunk names default to the module id, so a lazy chunk emits as `854.js`.
    // Those ids are derived from the module graph: a later release that adds or
    // reorders a module can hand different code the same file name, and a
    // browser still holding the old `854.js` will run it against the new
    // container. The content hash makes a changed chunk a different URL.
    //
    // Only the chunks: `remoteEntry.js` is named explicitly by
    // ModuleFederationPlugin below and has to keep its fixed name, because the
    // admin UI loads it with a <script> tag built from the package name.
    chunkFilename: '[name].[contenthash].js',
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
  },
  module: {
    rules: [
      {
        // Inlined as a string rather than emitted as a file: the panel is
        // served from a boat's own Signal K server, and a stylesheet that
        // arrives separately is one more request that can fail on a bad link.
        test: /\.css$/i,
        type: 'asset/source',
      },
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'ts-loader',
          options: { configFile: 'tsconfig.webapp.json', transpileOnly: false },
        },
      },
    ],
  },
  plugins: [
    new EmitAppIcon(packageJson.signalk.appIcon),
    new ModuleFederationPlugin({
      name: containerName,
      library: { type: 'var', name: containerName },
      filename: 'remoteEntry.js',
      // The exposed name is fixed by the server: an embeddable webapp panel
      // must be exposed as './AppPanel'.
      exposes: {
        './AppPanel': './src/webapp/AppPanel.tsx',
      },
      // React must be the host's instance. A second copy makes the panel's
      // hooks read a dispatcher the host never activated, which fails at
      // runtime with "Cannot read properties of null (reading 'useState')".
      shared: {
        react: { singleton: true, requiredVersion: '^19' },
        'react-dom': { singleton: true, requiredVersion: '^19' },
        // Module Federation matches share keys by exact request, so sharing
        // 'react' does not cover 'react/jsx-runtime'. With the automatic JSX
        // runtime, leaving it out makes the panel build elements with its own
        // bundled React while the components run on the host's — which works
        // only for as long as the two agree on the element symbol. React 19
        // renamed it, so a host on 18 would reject every element this panel
        // produced.
        'react/jsx-runtime': { singleton: true, requiredVersion: '^19' },
      },
    }),
  ],
};
