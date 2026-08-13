// Learn more https://docs.expo.dev/guides/monorepos/
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

const ENGINE_SRC = path.resolve(__dirname, '../../packages/engine/src');

/**
 * Let Metro follow the engine's `./rng.js` imports to `rng.ts`.
 *
 * `@bj/engine` is consumed as TypeScript source, and it is written in the
 * ESM style TypeScript asks for: a relative import names the *emitted* file,
 * so `src/index.ts` says `export * from './rng.js'` even though only `rng.ts`
 * exists on disk. Node and tsc both understand that; Metro resolves the
 * specifier literally and fails.
 *
 * Fixed here rather than in the engine because this is a fact about *this
 * bundler*, not about the engine — which builds, typechecks and tests fine as
 * written, and whose 685 tests import it the same way. Rewriting 21 source
 * files to suit Metro would put a bundler's constraint inside a package whose
 * whole claim is that it depends on nothing.
 *
 * Scoped to the engine directory so a genuinely missing `.js` file anywhere in
 * the app still fails loudly instead of being silently retried as `.ts`.
 */
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const fromEngine = context.originModulePath.startsWith(ENGINE_SRC);
  if (fromEngine && moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    return context.resolveRequest(context, moduleName.replace(/\.js$/, '.ts'), platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
