const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const isWatch = process.argv.includes('--watch');

const htmlPlugin = {
  name: 'html-inline',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;

      const jsPath = path.resolve(__dirname, 'dist/ui.js');
      if (!fs.existsSync(jsPath)) return;

      const js = fs.readFileSync(jsPath, 'utf8');
      const htmlTemplate = fs.readFileSync(
        path.resolve(__dirname, 'src/ui.html'),
        'utf8'
      );
      const html = htmlTemplate.replace(
        '<!-- SCRIPT_PLACEHOLDER -->',
        () => `<script>${js}</script>`
      );
      fs.writeFileSync(path.resolve(__dirname, 'dist/ui.html'), html);
      fs.unlinkSync(jsPath);
    });
  },
};

async function build() {
  const commonOptions = {
    bundle: true,
    minify: true,
    target: 'es2017',
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  };

  const sandboxCtx = await esbuild.context({
    ...commonOptions,
    entryPoints: ['src/code.ts'],
    outfile: 'dist/code.js',
    format: 'iife',
  });

  const nodeShimPlugin = {
    name: 'node-shim',
    setup(build) {
      build.onResolve({ filter: /^util$/ }, () => ({
        path: 'util',
        namespace: 'node-shim',
      }));
      build.onResolve({ filter: /^zlib$/ }, () => ({
        path: 'zlib',
        namespace: 'node-shim',
      }));
      build.onLoad({ filter: /.*/, namespace: 'node-shim' }, () => ({
        contents: 'export default {}; export const inspect = () => "";',
        loader: 'js',
      }));
    },
  };

  const uiCtx = await esbuild.context({
    ...commonOptions,
    entryPoints: ['src/ui.ts'],
    outfile: 'dist/ui.js',
    format: 'iife',
    platform: 'browser',
    plugins: [nodeShimPlugin, htmlPlugin],
  });

  if (isWatch) {
    await sandboxCtx.watch();
    await uiCtx.watch();
    console.log('Watching for changes...');
  } else {
    await sandboxCtx.rebuild();
    await uiCtx.rebuild();
    await sandboxCtx.dispose();
    await uiCtx.dispose();
    console.log('Build complete.');
  }
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
