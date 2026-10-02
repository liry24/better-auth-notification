import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../', import.meta.url))
const packageDirectory = join(root, 'packages/better-auth-notification')

function run(program: string, args: string[], cwd: string) {
    try {
        if (process.platform === 'win32' && program === 'npm') {
            return execFileSync(
                process.execPath,
                [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...args],
                { cwd, encoding: 'utf8', stdio: 'pipe' },
            )
        }
        return execFileSync(program, args, { cwd, encoding: 'utf8', stdio: 'pipe' })
    } catch (error) {
        if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string') {
            throw new Error(`${error.message}\n${error.stdout}`, { cause: error })
        }
        throw error
    }
}

it('installs and exercises the actual tarball in an isolated consumer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'notification-consumer-'))
    try {
        let tarball = process.env.NOTIFICATION_TARBALL
        if (!tarball) {
            run('bun', ['run', 'build'], root)
            const packDirectory = join(directory, 'pack')
            await mkdir(packDirectory)
            run('bun', ['pm', 'pack', '--destination', packDirectory, '--ignore-scripts'], packageDirectory)
            const archives = (await readdir(packDirectory)).filter((name) => name.endsWith('.tgz'))
            assert.equal(archives.length, 1, 'Expected exactly one packed archive')
            tarball = join(packDirectory, archives[0]!)
        }
        const before = createHash('sha256')
            .update(await readFile(tarball))
            .digest('hex')
        const entries = run('tar', ['-tzf', tarball], directory).trim().split(/\r?\n/u)
        expect(
            entries.every((entry) => /^package\/(?:dist(?:\/.*)?|package.json|README.md|LICENSE)$/u.test(entry)),
        ).toBe(true)
        await copyFile(tarball, join(directory, 'package.tgz'))
        const version = process.env.NOTIFICATION_BETTER_AUTH_VERSION ?? '1.7.7'
        const manager = process.env.NOTIFICATION_PACKAGE_MANAGER ?? 'bun'
        assert(['bun', 'npm', 'pnpm'].includes(manager), 'Unsupported consumer package manager')
        await writeFile(
            join(directory, 'package.json'),
            JSON.stringify({
                name: 'notification-consumer',
                private: true,
                type: 'module',
                dependencies: {
                    'better-auth-notification': 'file:./package.tgz',
                    'better-auth': version,
                    '@better-auth/core': version,
                },
                devDependencies: { typescript: '^7.0.2', '@types/node': '^26.6.3' },
            }),
        )
        run(manager, ['install', '--ignore-scripts'], directory)
        await writeFile(
            join(directory, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {
                    module: 'NodeNext',
                    moduleResolution: 'NodeNext',
                    target: 'ES2022',
                    types: ['node'],
                    strict: true,
                    skipLibCheck: true,
                    noEmit: true,
                },
                include: ['consumer.ts', 'client.ts'],
            }),
        )
        await writeFile(
            join(directory, 'consumer.ts'),
            `import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
import { notification } from 'better-auth-notification'
const database = new DatabaseSync(':memory:')
const auth = betterAuth({ database, baseURL: 'http://localhost:3000', secret: 'packed-consumer-secret-more-than-thirty-two-characters', emailAndPassword: { enabled: true }, plugins: [notification()], logger: { disabled: true } })
await (await getMigrations(auth.options)).runMigrations()
const registered = await auth.api.signUpEmail({ body: { name: 'Consumer', email: 'consumer@example.com', password: 'a-long-consumer-password' }, asResponse: true })
assert.equal(registered.status, 200)
const signup = await registered.json() as { user: { id: string } }
const body = { recipients: [signup.user.id], notification: { type: 'test', title: 'Packed' }, idempotencyKey: 'packed' }
assert.equal((await auth.api.sendNotification({ body })).results[0]?.status, 'created')
assert.equal((await auth.api.sendNotification({ body })).results[0]?.status, 'duplicate')
const cookie = registered.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ')
const response = await auth.handler(new Request('http://localhost:3000/api/auth/notification/list', { headers: { cookie } }))
assert.equal(response.status, 200)
assert.equal((await response.json()).notifications[0].title, 'Packed')
database.close()
`,
        )
        await writeFile(
            join(directory, 'client.ts'),
            `import { createAuthClient } from 'better-auth/client'
import { notificationClient } from 'better-auth-notification/client'
export const client = createAuthClient({ plugins: [notificationClient()] })
void client.notification.list({ query: { limit: 20 } })
void client.notification.setRead({ id: 'one', read: true })
void client.notification.refetch()
// @ts-expect-error The send API is server-only.
void client.sendNotification({})
`,
        )
        run('bun', ['x', '--no-install', 'tsc', '--noEmit'], directory)
        run(process.execPath, ['consumer.ts'], directory)
        run('bun', ['build', 'client.ts', '--target', 'browser', '--outdir', 'bundle'], directory)
        const bundle = await readFile(join(directory, 'bundle/client.js'), 'utf8')
        expect(bundle).not.toMatch(/createAuthEndpoint|Notification hook failed|node:sqlite/u)
        const after = createHash('sha256')
            .update(await readFile(tarball))
            .digest('hex')
        expect(after).toBe(before)
    } finally {
        // Only remove the exact temporary directory created by this test.
        assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
        assert(directory.startsWith(join(tmpdir(), 'notification-consumer-')))
        await rm(directory, { recursive: true, force: true })
    }
})
