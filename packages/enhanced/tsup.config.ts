import { defineConfig } from 'tsup';

export default defineConfig(({ watch }) => {
  const isDev = !!watch;
  return {
    dts: true,
    entry: {
      index: 'src/index.ts',
      webpack: 'src/webpack.ts',
      rspack: 'src/rspack.ts',
      runtime: 'src/runtime.ts',
      prefetch: 'src/prefetch.ts',
      sdk: 'src/sdk.ts',
    },
    /**
        "@module-federation/sdk": "workspace:*",
        "@module-federation/runtime-tools": "workspace:*",
        "@module-federation/manifest": "workspace:*",
        "@module-federation/managers": "workspace:*",
        "@module-federation/dts-plugin": "workspace:*",
        "@module-federation/rspack": "workspace:*",
        "@module-federation/bridge-react-webpack-plugin": "workspace:*",
        "@module-federation/data-prefetch": "workspace:*",
     */
    noExternal: [
      '@module-federation/sdk',
      '@module-federation/runtime-tools',
      '@module-federation/manifest',
      '@module-federation/managers',
      '@module-federation/rspack',
      '@module-federation/runtime',
      '@module-federation/data-prefetch',
      '@module-federation/bridge-react-webpack-plugin',
      // '@module-federation/dts-plugin'
    ],
    // external: ['typescript'],
    format: ['cjs', 'esm'],
    clean: true,
    minify: !isDev,
    // sourcemap: true,
    outExtension({ format }) {
      return {
        js: format === 'cjs' ? '.js' : '.mjs',
        dts: '.d.ts',
      };
    },
    onSuccess: async () => {
      console.log(
        '✅ Enhanced package built successfully with all dependencies bundled!',
      );
    },
    esbuildOptions(options: any, context) {
      options.logOverride = {
        'direct-eval': 'silent',
        'package.json': 'silent',
        'require-resolve-not-external': 'silent',
        'ignored-bare-import': 'silent',
      };
    },
  };
});
