//@ts-check
'use strict';

const path = require('path');

/** @type {import('webpack').Configuration[]} */
const config = [
  // Extension host bundle (runs in Node.js)
  {
    target: 'node',
    mode: 'none',
    entry: './src/extension.ts',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'extension.js',
      libraryTarget: 'commonjs2'
    },
    externals: {
      vscode: 'commonjs vscode'
    },
    resolve: {
      extensions: ['.ts', '.js']
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: [{ loader: 'ts-loader' }]
        }
      ]
    },
    devtool: 'nosources-source-map',
    infrastructureLogging: { level: 'log' }
  },
  // Webview bundle (runs in browser context inside VS Code webview)
  {
    target: 'web',
    mode: 'none',
    entry: './src/webview/index.ts',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'webview.js'
    },
    resolve: {
      extensions: ['.ts', '.js']
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: [{ loader: 'ts-loader', options: { configFile: path.resolve(__dirname, 'tsconfig.webview.json') } }]
        }
      ]
    },
    devtool: 'nosources-source-map'
  }
];

module.exports = config;
