const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'));
const version = (process.env.VERSION || pkg.version).replace(/^v/, '');
const isWatch = process.argv.includes('--watch');

const htmlPlugin = {
  name: 'html-inline',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;

      const jsPath = path.resolve(__dirname, 'dist/ui.js');
      const cssPath = path.resolve(__dirname, 'dist/ui.css');
      if (!fs.existsSync(jsPath)) return;

      const js = esbuild.transformSync(fs.readFileSync(jsPath, 'utf8'), {
        minifyIdentifiers: true,
        minifyWhitespace: true,
      }).code;
      const css = fs.readFileSync(cssPath, 'utf8');

      const htmlTemplate = fs.readFileSync(
        path.resolve(__dirname, 'src/ui.html'),
        'utf8'
      );
      const html = htmlTemplate
        .replace('<!-- STYLE_PLACEHOLDER -->', () => `<style>${css}</style>`)
        .replace('<!-- SCRIPT_PLACEHOLDER -->', () => `<script>${js}</script>`);
      fs.writeFileSync(path.resolve(__dirname, 'dist/ui.html'), html);
      fs.unlinkSync(jsPath);
      fs.unlinkSync(cssPath);
    });
  },
};

const copyManifestPlugin = {
  name: 'copy-manifest',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      const distDir = path.resolve(__dirname, 'dist');

      const figmaManifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'manifest.json'), 'utf8'));
      figmaManifest.main = './code.js';
      figmaManifest.ui = './ui.html';
      fs.writeFileSync(path.resolve(distDir, 'manifest.json'), JSON.stringify(figmaManifest, null, 2));

      const legacyMasterGoManifest = path.resolve(distDir, 'manifest.mastergo.json');
      if (fs.existsSync(legacyMasterGoManifest)) {
        fs.unlinkSync(legacyMasterGoManifest);
      }
    });
  },
};

async function build() {
  const commonOptions = {
    bundle: true,
    target: 'es2017',
    define: {
      'process.env.NODE_ENV': '"production"',
      '__VERSION__': JSON.stringify(version),
    },
  };

  const sandboxCtx = await esbuild.context({
    ...commonOptions,
    minify: true,
    entryPoints: ['src/code.ts'],
    outfile: 'dist/code.js',
    format: 'iife',
    plugins: [copyManifestPlugin],
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
    minifyIdentifiers: false,
    minifySyntax: true,
    minifyWhitespace: true,
    entryPoints: ['src/ui.tsx'],
    outfile: 'dist/ui.js',
    format: 'iife',
    platform: 'browser',
    jsxFactory: 'h',
    jsxFragment: 'Fragment',
    loader: {
      '.module.css': 'local-css',
      '.css': 'css',
    },
    plugins: [
      {
        name: 'strip-css-bang-prefix',
        setup(build) {
          build.onResolve({ filter: /^!.*\.css$/ }, (args) => ({
            path: path.resolve(args.resolveDir, args.path.slice(1)),
          }));
        },
      },
      nodeShimPlugin,
      htmlPlugin,
    ],
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
