import type { Compiler, Compilation as CompilationType } from 'webpack';
import { normalizeWebpackPath } from '@module-federation/sdk/normalize-webpack-path';

const Compilation = require(
  normalizeWebpackPath('webpack/lib/Compilation'),
) as typeof import('webpack/lib/Compilation');
import { SyncHook } from 'tapable';
import ContainerEntryDependency from '../ContainerEntryDependency';
import FederationRuntimeDependency from './FederationRuntimeDependency';

/** @type {WeakMap<import("webpack").Compilation, CompilationHooks>} */
const compilationHooksMap = new WeakMap<
  import('webpack').Compilation,
  CompilationHooks
>();

const PLUGIN_NAME = 'FederationModulesPlugin';

/** @typedef {{ header: string[], beforeStartup: string[], startup: string[], afterStartup: string[], allowInlineStartup: boolean }} Bootstrap */

type CompilationHooks = {
  addContainerEntryModule: SyncHook<[ContainerEntryDependency], void>;
  getEntrypointRuntime: SyncHook<[string], void>;
  addFederationRuntimeModule: SyncHook<[FederationRuntimeDependency], void>;
};

class FederationModulesPlugin {
  /**
   * @param {Compilation} compilation the compilation
   * @returns {CompilationHooks} the attached hooks
   */
  static getCompilationHooks(compilation: CompilationType): CompilationHooks {
    if (!(compilation instanceof Compilation)) {
      throw new TypeError(
        "The 'compilation' argument must be an instance of Compilation",
      );
    }
    let hooks = compilationHooksMap.get(compilation);
    if (hooks === undefined) {
      hooks = {
        addContainerEntryModule: new SyncHook(['dependency']),
        getEntrypointRuntime: new SyncHook(['entrypoint']),
        addFederationRuntimeModule: new SyncHook(['module']), // Initialize new hook
      };
      compilationHooksMap.set(compilation, hooks);
    }
    return hooks;
  }

  constructor(options = {}) {
    //@ts-ignore
    this.options = options;
  }

  apply(compiler: Compiler) {
    compiler.hooks.compilation.tap(
      PLUGIN_NAME,
      (compilation: CompilationType, { normalModuleFactory }) => {
        const hooks = FederationModulesPlugin.getCompilationHooks(compilation);
      },
    );
  }
}

export default FederationModulesPlugin;