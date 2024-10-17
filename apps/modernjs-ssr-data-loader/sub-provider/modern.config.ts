import { appTools, defineConfig } from '@modern-js/app-tools';
import { moduleFederationPlugin } from '@module-federation/modern-js';

// https://modernjs.dev/en/configure/app/usage
export default defineConfig({
  runtime: {
    router: true,
  },

  plugins: [
    appTools({
      bundler: 'rspack',
    }),
    moduleFederationPlugin(),
  ],
  server: {
    port: 3064,
    ssr: {
      mode: 'stream',
    },
  },
});
