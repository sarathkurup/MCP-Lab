const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Reports build problems in the terminal in a format VS Code's problem matcher understands. */
const problemReporter = {
  name: 'problem-reporter',
  setup(build) {
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      });
      console.log(`[${new Date().toLocaleTimeString()}] build finished`);
    });
  },
};

/** The extension host bundle (node) and the webview bundle (browser) are built
 *  separately: they share the `src/core` and `src/shared` sources but nothing else. */
const targets = [
  {
    entryPoints: ['src/vscode/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['vscode'],
  },
  {
    entryPoints: ['src/webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    external: [],
  },
];

async function main() {
  const contexts = await Promise.all(
    targets.map((target) =>
      esbuild.context({
        ...target,
        bundle: true,
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        logLevel: 'silent',
        plugins: [problemReporter],
      }),
    ),
  );

  if (watch) {
    await Promise.all(contexts.map((ctx) => ctx.watch()));
  } else {
    await Promise.all(contexts.map((ctx) => ctx.rebuild()));
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
