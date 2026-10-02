import { defineConfig } from 'tsdown'

export default defineConfig({
    attw: { level: 'error', profile: 'esm-only' },
    clean: true,
    copy: [
        { from: '../../README.md', to: '.' },
        { from: '../../LICENSE', to: '.' },
    ],
    // better-call is a direct dependency because generated endpoint declarations import it.
    deps: { dts: { neverBundle: true }, neverBundle: true },
    dts: true,
    entry: { index: 'src/index.ts', client: 'src/client.ts' },
    exports: false,
    format: ['esm'],
    platform: 'neutral',
    publint: true,
    sourcemap: false,
    unbundle: true,
})
