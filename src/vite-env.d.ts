/// <reference types="vite/client" />

// Injected via vite.config.ts's `define` — a fresh value per build, used to
// cache-bust theme CSS URLs. See themeCssUrl() in theme-core.ts.
declare const __BUILD_ID__: string;