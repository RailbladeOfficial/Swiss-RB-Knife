import { defineConfig, type Plugin } from "vite";


const host = process.env.TAURI_DEV_HOST;

// Keeps #themeLink the LAST stylesheet in <head>, and stamps it with the
// build id.
//
// The ordering half is load-bearing, not cosmetic. Theme files aren't just
// :root variable sets — each one also carries ~30-50 component rules
// (.budget-summary-tab.active, .tab-btn.active, .primary-btn, …) that
// deliberately restate selectors already present in src/**.css at the SAME
// specificity. Equal specificity means the cascade is decided purely by load
// order, so the theme only wins if it loads last.
//
// index.html lists the src/**.css <link>s first and #themeLink last, which is
// what dev serves — correct. But on build, Vite bundles those src stylesheets
// into one hashed asset and APPENDS its <link> to the end of <head>, landing
// it after #themeLink and silently inverting the cascade. Theme component
// rules then lose to the base rules they were written to override, and the UI
// falls back to base colors (e.g. Halo's orange .budget-summary-tab.active
// reverting to blue var(--color-btn)) — dev-only-correct styling.
//
// Runs at order:"post" so Vite has already injected its tags, then relocates
// #themeLink below them. Applied in dev too: dev is already in the right
// order, so the move is a no-op there, and routing both through one code path
// keeps dev and prod cascade order provably identical.
function themeLinkPlugin(buildId: string): Plugin {
  const TAG_RE = /[ \t]*<link id="themeLink"[^>]*>\r?\n?/;

  return {
    name: "theme-link-last",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        if (!TAG_RE.test(html)) {
          // index.html no longer has the tag this plugin exists to place —
          // fail loudly rather than shipping a silently mis-ordered build.
          throw new Error(
            '[theme-link-last] No <link id="themeLink"> found in index.html. ' +
              "Theme CSS must load last; update this plugin if the tag was renamed.",
          );
        }
        return html.replace(TAG_RE, "").replace(
          /([ \t]*)<\/head>/,
          `  <link id="themeLink" rel="stylesheet" href="/themes/default.css?v=${buildId}" />\n$1</head>`,
        );
      },
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => {
  const buildId = String(Date.now());

  return {
    plugins: [themeLinkPlugin(buildId)],

    // Stamped onto theme CSS URLs (see themeCssUrl() in theme-core.ts) so
    // every build gets a fresh query string. Those files are swapped at
    // runtime via themeLink.href rather than flowing through Vite's module
    // graph, so they never get a content hash — without this, WebView2's
    // HTTP cache keeps serving old theme CSS after an in-place app update,
    // since the URL never changes even though the file on disk did.
    define: {
      __BUILD_ID__: JSON.stringify(buildId),
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        // 3. tell Vite to ignore watching `src-tauri`
        ignored: ["**/src-tauri/**"],
      },
    },
  };
});
