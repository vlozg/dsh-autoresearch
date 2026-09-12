import { readFile } from "node:fs/promises";
import { basename, dirname, resolve as resolvePath } from "node:path";
import pkg from "./package.json" with { type: "json" };
import { defineConfig, type UserConfig } from "tsdown";

/**
 * Two build faces of the dual-face package:
 * - host: the Cordis tool plugin (lib/index.mjs, ESM, dsh packages external);
 * - client: the Web UI bundle (lib/client.cjs, CJS in a type:module package) in
 *   dsh's closure-factory shape — the artifact registers itself through
 *   window.__ModuleLoader__.load, with platform modules resolved from the
 *   loader's frozen module table and every other dependency inlined. Mirrors
 *   deepseek-harness packages/client/tsdown.client.ts and the BrowserSkill
 *   reference plugin.
 */

/**
 * Module specifiers the dsh web shell shares into its frozen module table —
 * MUST stay in sync with PLATFORM_MODULES in
 * packages/client/web/src/platform.ts (the seed table's projection contract).
 */
const CLIENT_EXTERNALS: readonly string[] = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",
];

const CLIENT_ID = pkg.name;
const CSS_VIRTUAL_PREFIX = "\0ar-css:";
const CSS_VIRTUAL_SUFFIX = ".mjs";

const client: UserConfig = {
  name: CLIENT_ID + "/client",
  entry: { client: "src/client/index.ts" },
  outDir: "lib",
  format: "cjs",
  platform: "browser",
  dts: false,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  // Anything not in the loader module table must inline; an unanswerable
  // require() is a guaranteed runtime throw.
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
  },
  plugins: [
    {
      // Bundle purity gate: platform modules stay external, everything else
      // inlines; any other @deepseek-ai value import is a build error.
      name: "ar-client-bundle-purity",
      resolveId(source: string) {
        if (!source.startsWith("@deepseek-ai/")) return null;
        if (CLIENT_EXTERNALS.includes(source)) return null;
        throw new Error(
          'client bundle purity: "' + source + '" is not a platform module — ' +
            "collaborate through cordis services (type-only imports are erased and never reach this gate)",
        );
      },
    },
    {
      // .nomodule.css is inlined verbatim as a <style> tag (selectors stay
      // unhashed so the .ar- prefixed class names match).
      name: "ar-css-inline",
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith(".nomodule.css")) return null;
        const abs = importer !== undefined ? resolvePath(dirname(importer), source) : source;
        return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX;
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null;
        const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length);
        this.addWatchFile(fileId);
        const source = await readFile(fileId, "utf8");
        const tagId = CLIENT_ID + "/" + basename(fileId);
        return [
          "const css = " + JSON.stringify(source) + ";",
          "const tagId = " + JSON.stringify(tagId) + ";",
          "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
          "  const tag = document.createElement('style');",
          "  tag.dataset.plugin = " + JSON.stringify(CLIENT_ID) + ";",
          "  tag.dataset.pluginCss = tagId;",
          "  tag.textContent = css;",
          "  document.head.appendChild(tag);",
          "}",
          "export default {};",
        ].join("\n");
      },
    },
  ],
  outputOptions: {
    entryFileNames: "client.cjs",
    banner: "window.__ModuleLoader__.load({ id: " + JSON.stringify(CLIENT_ID) + ", factory: (require) => {",
    footer: "return module.exports; } });",
    intro: "var module = { exports: {} }; var exports = module.exports;",
  },
};

export default defineConfig([
  {
    entry: ["src/host/index.ts"],
    format: ["esm"],
    dts: true,
    outDir: "lib",
    // dsh host packages are provided by the profile the plugin is installed into.
    external: [/^@deepseek-ai\//],
  },
  client,
]);
