import { DatabaseSync } from 'node:sqlite'

import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'

import { notification } from '../packages/better-auth-notification/src/index'
import type { NotificationOptions } from '../packages/better-auth-notification/src/index'

export async function setup<TContext = undefined>(options: NotificationOptions<TContext> = {}, filename = ':memory:') {
    const database = new DatabaseSync(filename)
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    const auth = betterAuth({
        database,
        baseURL: 'http://localhost:3000',
        secret: 'notification-test-secret-at-least-thirty-two-characters',
        emailAndPassword: { enabled: true },
        user: { additionalFields: { plan: { type: 'string', defaultValue: 'free', input: false } } },
        plugins: [notification(options)],
        logger: { disabled: true },
    })
    const migrations = await getMigrations(auth.options)
    await migrations.runMigrations()
    const ctx = await auth.$context

    async function user(name = crypto.randomUUID()) {
        const response = await auth.api.signUpEmail({
            body: { email: `${name}@example.com`, password: 'a-long-test-password', name },
            asResponse: true,
        })
        if (!response.ok) throw new Error(await response.text())
        const data = (await response.json()) as { user: { id: string } }
        const headers = new Headers({ origin: 'http://localhost:3000' })
        headers.set(
            'cookie',
            response.headers
                .getSetCookie()
                .map((cookie) => cookie.split(';')[0])
                .join('; '),
        )
        return { id: data.user.id, headers }
    }

    function request(path: string, headers = new Headers(), body?: unknown) {
        const requestHeaders = new Headers(headers)
        if (body !== undefined) requestHeaders.set('content-type', 'application/json')
        return auth.handler(
            new Request(`http://localhost:3000/api/auth${path}`, {
                headers: requestHeaders,
                method: body === undefined ? 'GET' : 'POST',
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
        )
    }

    return {
        auth,
        ctx,
        database,
        user,
        request,
        close: () => {
            if (database.isOpen) database.close()
        },
    }
}

export const content = {
    type: 'post.published',
    title: 'A post is ready',
    actions: [{ id: 'view', label: 'View post', href: '/posts/123' }],
}
