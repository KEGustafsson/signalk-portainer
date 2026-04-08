const path = require('path')
const { ModuleFederationPlugin } = require('webpack').container
const { WatchIgnorePlugin } = require('webpack')
require('@signalk/server-admin-ui-dependencies')
const packageJson = require('./package.json')

module.exports = {
  entry: './src/components/AppPanel',
  mode: 'production',
  output: {
    path: path.resolve(__dirname, 'public'),
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js', '.jsx'],
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        loader: 'ts-loader',
        exclude: /node_modules/,
        options: {
          configFile: 'tsconfig.webpack.json',
        },
      },
    ],
  },
  plugins: [
    new ModuleFederationPlugin({
      name: 'signalk_portainer',
      library: { type: 'var', name: packageJson.name.replace(/[-@/]/g, '_') },
      filename: 'remoteEntry.js',
      exposes: {
        './AppPanel': './src/components/AppPanel',
      },
      shared: [{ react: { singleton: true } }],
    }),
    new WatchIgnorePlugin({
      paths: [path.resolve(__dirname, 'public/')],
    }),
  ],
}
