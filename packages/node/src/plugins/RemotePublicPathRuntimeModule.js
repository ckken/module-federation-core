import { RuntimeGlobals, RuntimeModule, Template, javascript } from "webpack";
import { getUndoPath } from 'webpack/lib/util/identifier';

class AutoPublicPathRuntimeModule extends RuntimeModule {
  constructor(options) {
    super("publicPath", RuntimeModule.STAGE_BASIC + 1);
    this.options = options
  }

  /**
   * @returns {string} runtime code
   */
  generate() {
    const { compilation } = this;
    const { scriptType, path, publicPath, importMetaName, uniqueName } = compilation.outputOptions;

    // If publicPath is not "auto", return the static value
    if (publicPath !== "auto") {
      return `${RuntimeGlobals.publicPath} = ${JSON.stringify(
        compilation.getPath(publicPath || "", {
          hash: compilation.hash || "XXXX"
        })
      )};`;
    }

    const chunkName = compilation.getPath(
      javascript.JavascriptModulesPlugin.getChunkFilenameTemplate(
        this.chunk,
        compilation.outputOptions
      ),
      {
        chunk: this.chunk,
        contentHashType: "javascript"
      }
    );
    const undoPath = getUndoPath(chunkName, path, false);
    const ident = Template.toIdentifier(uniqueName);

    return Template.asString([
      "var scriptUrl;",
      // its an esproxy so nesting into _config directly is not possible
      "var remoteReg = globalThis.__remote_scope__._config;",
      `
      let remoteContainerRegistry = {
        get url() {
          return remoteReg[${JSON.stringify(ident)}];
        }
      };
      `,
      
      scriptType === "module"
        ? Template.asString([
          'try {',           
            Template.indent([
              `scriptUrl = new Function('return typeof ${importMetaName}.url === "string" ? ${importMetaName}.url : undefined;')();`,
            ]),
            '} catch (e) {',
              Template.indent([
              `if (typeof remoteContainerRegistry.url === "string") {`,
              Template.indent('scriptUrl = remoteContainerRegistry.url;'),
              '} else {',
              Template.indent('scriptUrl = __filename;'),
              '}',
            ]),
          '}'
          ])
        : Template.asString([
          `if (${RuntimeGlobals.global}.importScripts) scriptUrl = ${RuntimeGlobals.global}.location + "";`,
          `var document = ${RuntimeGlobals.global}.document;`,
          "if (!scriptUrl && document) {",
          Template.indent([
            `if (document.currentScript)`,
            Template.indent(`scriptUrl = document.currentScript.src`),
            "if (!scriptUrl) {",
            Template.indent([
              'var scripts = document.getElementsByTagName("script");',
              "if(scripts.length) scriptUrl = scripts[scripts.length - 1].src"
            ]),
            "}"
          ]),
          "}",
        ]),
      "console.log('scriptUrl', scriptUrl);",
      "// When supporting server environments where an automatic publicPath is not supported, you must specify an output.publicPath manually via configuration",
      '// or pass an empty string ("") and set the __webpack_public_path__ variable from your code to use your own logic.',
      'if (!scriptUrl) throw new Error("Unable to calculate automatic public path");',
      'scriptUrl = scriptUrl.replace(/#.*$/, "").replace(/\\?.*$/, "").replace(/\\/[^\\/]+$/, "/");',
      !undoPath
        ? `${RuntimeGlobals.publicPath} = scriptUrl;`
        : `${RuntimeGlobals.publicPath} = scriptUrl + ${JSON.stringify(
          undoPath
        )};`
    ]);
  }
}

export default AutoPublicPathRuntimeModule;