import { normalizeWebpackPath } from '@module-federation/sdk/normalize-webpack-path';
import CustomRuntimeModule from './CustomRuntimeModule';
const { RuntimeGlobals } = require(
  normalizeWebpackPath('webpack'),
) as typeof import('webpack');
import type { Compiler, Compilation, Chunk } from 'webpack';

const onceForCompilationMap = new WeakMap();

class RuntimeModuleChunkPlugin {
  apply(compiler: Compiler): void {
    compiler.hooks.thisCompilation.tap(
      'ModuleChunkFormatPlugin',
      (compilation: Compilation) => {
        compilation.hooks.optimizeModuleIds.tap(
          'ModuleChunkFormatPlugin',
          (modules) => {
            for (const module of modules) {
              if (typeof module.id === 'string') {
                module.id = `(embed)${module.id}`;
              } else {
                module.id = `1000${module.id}`;
              }
            }
          },
        );

        const hooks =
          compiler.webpack.javascript.JavascriptModulesPlugin.getCompilationHooks(
            compilation,
          );

        hooks.renderChunk.tap(
          'ModuleChunkFormatPlugin',
          (modules, renderContext) => {
            const { chunk, chunkGraph } = renderContext;

            const source = new compiler.webpack.sources.ConcatSource();
            source.add('var federation = ');
            source.add(modules);
            source.add('\n');
            const entries = Array.from(
              chunkGraph.getChunkEntryModulesWithChunkGroupIterable(chunk),
            );
            for (let i = 0; i < entries.length; i++) {
              const [module, entrypoint] = entries[i];
              const final = i + 1 === entries.length;
              const moduleId = chunkGraph.getModuleId(module);
              source.add('\n');
              if (final) {
                source.add('for (var mod in federation) {\n');
                source.add(
                  `${RuntimeGlobals.moduleFactories}[mod] = federation[mod];\n`,
                );
                source.add('}\n');
                source.add('federation = ');
              }
              source.add(
                `${RuntimeGlobals.require}(${JSON.stringify(moduleId)});\n`,
              );
            }
            return source;
          },
        );
      },
    );
  }
}

class CustomRuntimePlugin {
  private entryModule?: string | number;
  private bundlerRuntimePath: string;

  constructor(path: string) {
    this.bundlerRuntimePath = path.replace('cjs', 'esm');
  }

  apply(compiler: Compiler): void {
    compiler.hooks.make.tapAsync(
      'CustomRuntimePlugin',
      (compilation: Compilation, callback: (err?: Error) => void) => {
        if (onceForCompilationMap.has(compilation)) return callback();
        onceForCompilationMap.set(compilation, null);

        const childCompiler = compilation.createChildCompiler(
          'CustomRuntimePluginCompiler',
          {
            filename: '[name].js',
            library: {
              type: 'var',
              name: 'federation',
              export: 'default',
            },
          },
          [
            new compiler.webpack.EntryPlugin(
              compiler.context,
              this.bundlerRuntimePath,
              {
                name: 'custom-runtime-bundle',
                runtime: 'other',
              },
            ),
            new compiler.webpack.library.EnableLibraryPlugin('var'),
            new RuntimeModuleChunkPlugin(),
          ],
        );

        childCompiler.context = compiler.context;
        childCompiler.options.devtool = undefined;
        childCompiler.options.optimization.splitChunks = false;
        childCompiler.options.optimization.removeAvailableModules = true;
        console.log('Creating child compiler for', this.bundlerRuntimePath);

        childCompiler.hooks.thisCompilation.tap(
          this.constructor.name,
          /**
           * @param {Compilation} childCompilation
           */
          (childCompilation) => {
            childCompilation.hooks.processAssets.tap(
              this.constructor.name,
              () => {
                const source =
                  childCompilation.assets['custom-runtime-bundle.js'] &&
                  (childCompilation.assets[
                    'custom-runtime-bundle.js'
                  ].source() as string);

                const entry = childCompilation.entrypoints.get(
                  'custom-runtime-bundle',
                );
                const entryChunk = entry?.getEntrypointChunk();

                if (entryChunk) {
                  const entryModule = Array.from(
                    childCompilation.chunkGraph.getChunkEntryModulesIterable(
                      entryChunk,
                    ),
                  )[0];
                  this.entryModule =
                    childCompilation.chunkGraph.getModuleId(entryModule);
                }

                onceForCompilationMap.set(compilation, source);
                console.log('got compilation asset');
                // Remove all chunk assets
                childCompilation.chunks.forEach((chunk) => {
                  chunk.files.forEach((file) => {
                    childCompilation.deleteAsset(file);
                  });
                });
              },
            );
          },
        );
        childCompiler.runAsChild(
          (
            err?: Error | null,
            entries?: Chunk[],
            childCompilation?: Compilation,
          ) => {
            if (err) {
              return callback(err);
            }

            if (!childCompilation) {
              console.warn(
                'Embed Federation Runtime: Child compilation is undefined',
              );
              return callback();
            }

            if (childCompilation.errors.length) {
              return callback(childCompilation.errors[0]);
            }

            console.log('Code built successfully');

            callback();
          },
        );
      },
    );

    compiler.hooks.thisCompilation.tap(
      'CustomRuntimePlugin',
      (compilation: Compilation) => {
        compilation.hooks.additionalTreeRuntimeRequirements.tap(
          'CustomRuntimePlugin',
          (chunk: Chunk, runtimeRequirements: Set<string>) => {
            if (runtimeRequirements.has('embeddedFederationRuntime')) return;
            if (
              !runtimeRequirements.has(`${RuntimeGlobals.require}.federation`)
            )
              return;
            const bundledCode = onceForCompilationMap.get(compilation);
            if (!bundledCode) return;

            runtimeRequirements.add('embeddedFederationRuntime');
            const runtimeModule = new CustomRuntimeModule(
              bundledCode,
              this.entryModule,
            );

            compilation.addRuntimeModule(chunk, runtimeModule);
            console.log(`Custom runtime module added to chunk: ${chunk.name}`);
          },
        );
      },
    );
  }
}

export default CustomRuntimePlugin;