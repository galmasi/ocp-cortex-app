import { Configuration } from 'webpack';
import webpack from 'webpack';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

// Read package.json directly — importing JSON needs import attributes
// under ESM ts-node, which is more friction than a file read.
const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);

/**
 * Standalone SPA build. Output goes straight into the app image's build
 * context (podman build cortex-app-image/) — index.html is copied by
 * the Dockerfile next to the bundle.
 */
const config: Configuration = {
  mode: 'production',
  entry: {
    app: './src/main.tsx',
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'ts-loader',
          options: {
            transpileOnly: true,
          },
        },
      },
      {
        // Includes node_modules — xterm.js ships its own CSS.
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
  },
  output: {
    path: fileURLToPath(new URL('./cortex-app-image/dist', import.meta.url)),
    // Content-hashed filename: deploys bust the browser cache without a
    // hard refresh (index.html itself is never cached long).
    filename: '[name]-bundle.[contenthash:8].js',
    publicPath: '/',
  },
  plugins: [
    // Bake the app version into the bundle at build time so the page
    // can display it — the single source of truth is package.json's
    // version, which must be bumped every deploy anyway.
    new webpack.DefinePlugin({
      CORTEX_PLUGIN_VERSION: JSON.stringify(pkg.version),
    }),
  ],
  devtool: 'source-map',
};

export default config;
