import { createRequire } from 'node:module';
globalThis.require = createRequire(import.meta.url);
import { build } from 'esbuild';
import esbuildPluginPino from 'esbuild-plugin-pino';
await build({ entryPoints: ['runner.ts'], platform: 'node', bundle: true, format: 'esm', outdir: 'out', absWorkingDir: new URL('.', import.meta.url).pathname, plugins: [esbuildPluginPino({ transports: ['pino-pretty'] })], banner: {js: `import { createRequire as __bannerCrReq } from 'node:module'; globalThis.require = __bannerCrReq(import.meta.url);`} });
