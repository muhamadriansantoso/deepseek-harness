import { defineConfig } from 'tsdown'

/**
 * dsh-runner ships the plugin (`index`), its invariants, the startup provider,
 * and the standalone CLI `bin` (referenced by package.json
 * `bin`/`exports["./bin"]`). The root tsdown builds only
 * `lib/types/{index,invariant,startup}.js`, so this override adds
 * `lib/types/bin.js`. Declarations come from `tsc -b` (dts: false),
 * matching every package.
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/invariant.js', 'lib/types/startup.js', 'lib/types/bin.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
