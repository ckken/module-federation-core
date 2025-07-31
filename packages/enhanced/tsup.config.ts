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
    },
    noExternal: [
      '@module-federation/manifest',
      '@module-federation/runtime',
      '@module-federation/runtime-tools/runtime',
    ],
    format: ['cjs', 'esm'],
    clean: true,
    minify: !isDev,
    sourcemap: true,
    outExtension({ format }) {
      return {
        js: format === 'cjs' ? '.js' : '.mjs',
      };
    },
    onSuccess: async () => {
      console.log(
        '✅ Enhanced package built successfully with all dependencies bundled!',
      );
    },
  };
});
