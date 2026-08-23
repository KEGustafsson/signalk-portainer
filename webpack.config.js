const path = require('path');
const { ModuleFederationPlugin } = require('webpack').container;
const packageJson = require('./package.json');

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
      },
    }),
  ],
};
