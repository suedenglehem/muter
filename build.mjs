import * as esbuild from "esbuild";
import { cpSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const dist = join(root, "dist");
const src = join(root, "src");

// Ensure dist exists
mkdirSync(dist, { recursive: true });
mkdirSync(join(dist, "audio"), { recursive: true });
mkdirSync(join(dist, "worklet"), { recursive: true });
mkdirSync(join(dist, "popup"), { recursive: true });

const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const commonOptions = {
  bundle: true,
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  target: "chrome120",
  define: {
    "process.env.NODE_ENV": watch ? '"development"' : '"production"',
  },
};

// Build entries
const entries = [
  // Service worker (background)
  {
    entryPoints: [join(src, "service-worker.ts")],
    outfile: join(dist, "service-worker.js"),
    ...commonOptions,
    format: "iife",
  },
  // Audio page script (hidden extension page that owns tabCapture + graph)
  {
    entryPoints: [join(src, "audio/audio.ts")],
    outfile: join(dist, "audio/audio.js"),
    ...commonOptions,
    format: "iife",
  },
  // AudioWorklet processor (must be a standalone script)
  {
    entryPoints: [join(src, "worklet/analysis-worklet.ts")],
    outfile: join(dist, "worklet/analysis-worklet.js"),
    ...commonOptions,
    format: "iife",
  },
  // Popup script
  {
    entryPoints: [join(src, "popup/popup.ts")],
    outfile: join(dist, "popup/popup.js"),
    ...commonOptions,
    format: "iife",
  },
];

async function build() {
  if (watch) {
    const contexts = await Promise.all(entries.map((opts) => esbuild.context(opts)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log("[muter] Watching for changes...");
  } else {
    await Promise.all(entries.map((opts) => esbuild.build(opts)));
    console.log("[muter] Build complete.");
  }

  // Copy static assets
  const staticFiles = [
    { from: join(src, "manifest.json"), to: join(dist, "manifest.json") },
    { from: join(src, "audio/audio.html"), to: join(dist, "audio/audio.html") },
    { from: join(src, "popup/popup.html"), to: join(dist, "popup/popup.html") },
    { from: join(src, "popup/popup.css"), to: join(dist, "popup/popup.css") },
  ];

  for (const file of staticFiles) {
    if (existsSync(file.from)) {
      cpSync(file.from, file.to);
    } else {
      console.warn(`[muter] Missing static file: ${file.from}`);
    }
  }

  if (!watch) {
    console.log("[muter] Static assets copied.");
    console.log(`[muter] Extension ready at: ${dist}`);
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
