import pkg from "./package.json" with { type: "json" };
import { defineConfig, type UserConfig } from "tsdown";

/**
 * Two build faces of the dual-face package:
 * - host: the Cordis tool plugin (lib/index.mjs, ESM, dsh packages external);
 * - client: the Web UI bundle (lib/client.cjs, CJS closure-factory shape) —
 *   registers itself via window.__ModuleLoader__.load; platform modules come
 *   from the loader's frozen module table, everything else is inlined.
 */

/** Module specifiers the dsh web shell shares into its frozen module table. */
const CLIENT_EXTERNALS: readonly string[] = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-web-react",
  "@deepseek-ai/dsh-client-ui-primitives",
];

const CLIENT_ID = pkg.name;

const client: UserConfig = {
  name: `${CLIENT_ID}/client`,
  entry: { client: "src/client/index.ts" },
  outDir: "lib",
  format: "cjs",
  platform: "browser",
  dts: false,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
  },
  plugins: [
    {
      // Bundle purity gate: platform modules stay external, everything else inlines.
      name: "ar-client-bundle-purity",
      resolveId(source: string) {
        if (!source.startsWith("@deepseek-ai/")) return null;
        if (CLIENT_EXTERNALS.includes(source)) return null;
        throw new Error(
          `client bundle purity: "${source}" is not a platform module — collaborate through cordis services (type-only imports never reach this gate)`,
        );
      },
    },
  ],
  outputOptions: {
    entryFileNames: "client.cjs",
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_ID)}, factory: (require) => {`,
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
