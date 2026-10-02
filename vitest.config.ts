import { defineConfig } from 'vitest/config'

export default defineConfig({
    tsconfig: 'test/tsconfig.json',
    test: {
        fileParallelism: false,
        maxWorkers: 1,
        projects: ['unit', 'integration', 'client', 'consumer'].map((name) => ({
            test: {
                name,
                include: [`test/${name}/**/*.test.ts`],
                environment: 'node',
                fileParallelism: false,
                hookTimeout: 300_000,
                testTimeout: 300_000,
            },
        })),
    },
})
