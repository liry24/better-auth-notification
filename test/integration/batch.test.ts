import { afterEach, expect, it, vi } from 'vitest'

import type { RecipientData, RecipientFilter } from '../../packages/better-auth-notification/src/index'
import { content, setup } from '../utils'

const cleanups: (() => void)[] = []
afterEach(() => {
    for (const close of cleanups.splice(0)) close()
})

it('bounds scanning, continues through empty matches, and evaluates live user data', async () => {
    const app = await setup({ loadContext: ({ user }) => ({ allowed: user.plan === 'pro' }) })
    cleanups.push(app.close)
    const users = []
    for (let i = 0; i < 5; i++)
        users.push(
            await app.ctx.internalAdapter.createUser(
                { name: `user${i}`, email: `batch${i}@example.com` },
                { method: 'email-password' },
            ),
        )
    const ids = users.map((user) => user.id).toSorted()
    const filter = vi.fn<RecipientFilter<{ allowed: boolean }>>(async ({ user, accounts, sessions, context }) => {
        expect(user).toHaveProperty('email')
        expect(accounts).toEqual([])
        expect(sessions).toEqual([])
        return context?.allowed === true
    })
    const body = { recipients: 'all' as const, idempotencyKey: 'campaign', notification: content, limit: 2, filter }
    const first = await app.auth.api.sendNotification({ body })
    expect(first.results.map((result) => result.userId)).toEqual(ids.slice(0, 2))
    expect(first.results.every((result) => result.status === 'skipped')).toBe(true)
    expect(first.nextCursor).toBe(ids[1])
    expect(first.hasMore).toBe(true)
    expect(filter).toHaveBeenCalledTimes(2)

    await app.ctx.adapter.update({ model: 'user', where: [{ field: 'id', value: ids[2]! }], update: { plan: 'pro' } })
    const second = await app.auth.api.sendNotification({ body: { ...body, cursor: first.nextCursor! } })
    expect(second.results.map((result) => result.status)).toEqual(['created', 'skipped'])
    const last = await app.auth.api.sendNotification({ body: { ...body, cursor: second.nextCursor! } })
    expect(last.results).toHaveLength(1)
    expect(last).toMatchObject({ nextCursor: null, hasMore: false })
    expect(filter).toHaveBeenCalledTimes(5)
})

it('returns partial failures and supports explicit-ID retries with the same key', async () => {
    let shouldFail = true
    const app = await setup({
        loadContext: ({ user }) => {
            if (user.name === 'failure' && shouldFail) throw new Error('private database information')
            return { selected: true }
        },
    })
    cleanups.push(app.close)
    const good = await app.ctx.internalAdapter.createUser(
        { name: 'good', email: 'good@example.com' },
        { method: 'email-password' },
    )
    const bad = await app.ctx.internalAdapter.createUser(
        { name: 'failure', email: 'bad@example.com' },
        { method: 'email-password' },
    )
    const body = { recipients: [good.id, bad.id, good.id, 'missing'], notification: content, idempotencyKey: 'retry' }
    const sent = await app.auth.api.sendNotification({ body })
    expect(sent.results).toHaveLength(3)
    expect(sent.results.find((result) => result.userId === good.id)?.status).toBe('created')
    expect(sent.results.find((result) => result.userId === bad.id)).toMatchObject({
        status: 'failed',
        error: { code: 'NOTIFICATION_SEND_FAILED' },
    })
    expect(sent.results.find((result) => result.userId === 'missing')).toMatchObject({
        status: 'failed',
        error: { code: 'NOTIFICATION_USER_NOT_FOUND' },
    })
    expect(JSON.stringify(sent)).not.toContain('private database')
    shouldFail = false
    const retry = await app.auth.api.sendNotification({ body })
    expect(retry.results.find((result) => result.userId === good.id)?.status).toBe('duplicate')
    expect(retry.results.find((result) => result.userId === bad.id)?.status).toBe('created')
    expect(await app.ctx.adapter.count({ model: 'notification' })).toBe(2)
    expect(await app.auth.api.sendNotification({ body: { ...body, recipients: [] } })).toEqual({
        results: [],
        nextCursor: null,
        hasMore: false,
    })
})

it('loads every related row without tokens, including beyond the adapter default page', async () => {
    const app = await setup()
    cleanups.push(app.close)
    const user = await app.user()
    for (let index = 0; index < 105; index++) {
        await app.ctx.internalAdapter.linkAccount({
            userId: user.id,
            providerId: `provider${index}`,
            accountId: `account${index}`,
            accessToken: 'access-secret',
            refreshToken: 'refresh-secret',
            idToken: 'id-secret',
            password: 'hash-secret',
        })
        await app.ctx.internalAdapter.createSession(user.id)
    }
    const expired = await app.ctx.internalAdapter.createSession(user.id)
    await app.ctx.adapter.update({
        model: 'session',
        where: [{ field: 'id', value: expired.id }],
        update: { expiresAt: new Date(0) },
    })
    let observed: RecipientData | undefined
    const result = await app.auth.api.sendNotification({
        body: {
            recipients: [user.id],
            idempotencyKey: 'relations',
            notification: content,
            filter: (recipient) => {
                observed = recipient
                return true
            },
        },
    })
    expect(result.results[0]?.status).toBe('created')
    expect(observed?.user.plan).toBe('free')
    expect(observed?.accounts).toHaveLength(106)
    expect(observed?.sessions).toHaveLength(106)
    for (const account of observed!.accounts) {
        for (const key of ['accessToken', 'refreshToken', 'idToken', 'password'])
            expect(account).not.toHaveProperty(key)
    }
    for (const session of observed!.sessions) expect(session).not.toHaveProperty('token')
    expect(JSON.stringify({ accounts: observed!.accounts, sessions: observed!.sessions })).not.toContain('secret')
})

it('paginates explicit recipients and notifications and filters unread archived items', async () => {
    const app = await setup()
    cleanups.push(app.close)
    const user = await app.user()
    const other = await app.user()
    const ids = [user.id, other.id].toSorted()
    const body = { recipients: ids, idempotencyKey: 'paged', notification: content, limit: 1 }
    const first = await app.auth.api.sendNotification({ body })
    const second = await app.auth.api.sendNotification({ body: { ...body, cursor: first.nextCursor! } })
    expect(first.results[0]?.userId).toBe(ids[0])
    expect(second.results[0]?.userId).toBe(ids[1])
    expect(second.hasMore).toBe(false)
    for (let i = 0; i < 3; i++)
        await app.auth.api.sendNotification({ body: { ...body, recipients: [user.id], idempotencyKey: `page${i}` } })
    const page = await app.auth.api.listNotifications({ headers: user.headers, query: { limit: 2 } })
    expect(page).toMatchObject({ total: 4, nextOffset: 2 })
    const next = await app.auth.api.listNotifications({
        headers: user.headers,
        query: { limit: 2, offset: page.nextOffset! },
    })
    expect(next.nextOffset).toBeNull()
    expect(new Set([...page.notifications, ...next.notifications].map((item) => item.id)).size).toBe(4)
    const id = page.notifications[0]!.id
    await app.auth.api.setNotificationArchived({ headers: user.headers, body: { id, archived: true } })
    expect(
        (
            await app.auth.api.listNotifications({
                headers: user.headers,
                query: { archived: 'archived', read: 'unread' },
            })
        ).total,
    ).toBe(1)
    expect(
        (await app.auth.api.listNotifications({ headers: user.headers, query: { archived: 'all', read: 'read' } }))
            .total,
    ).toBe(0)
})
