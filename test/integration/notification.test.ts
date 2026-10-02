import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotificationOptions } from '../../packages/better-auth-notification/src/index'
import { content, setup } from '../utils'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
})

describe('notification plugin against real SQLite', () => {
    it('sends, lists, changes independent states, and calls hooks only on actual changes', async () => {
        const onNotificationCreated = vi.fn<NonNullable<NotificationOptions['onNotificationCreated']>>()
        const onReadStateChanged = vi.fn<NonNullable<NotificationOptions['onReadStateChanged']>>()
        const onArchiveStateChanged = vi.fn<NonNullable<NotificationOptions['onArchiveStateChanged']>>()
        const app = await setup({ onNotificationCreated, onReadStateChanged, onArchiveStateChanged })
        cleanups.push(app.close)
        const user = await app.user()
        const send = await app.auth.api.sendNotification({
            body: { recipients: [user.id, user.id], idempotencyKey: 'post:1', notification: content },
        })
        expect(send.results).toHaveLength(1)
        const item = send.results[0]!
        expect(item.status).toBe('created')
        if (item.status !== 'created') throw new Error('Expected a notification')
        expect(item.hook).toBe('completed')
        expect(item.notification.readAt).toBeNull()
        expect(onNotificationCreated).toHaveBeenCalledTimes(1)
        expect(onNotificationCreated.mock.calls[0]![0].recipient.user.plan).toBe('free')
        const id = item.notification.id

        expect(await app.auth.api.getUnreadNotificationCount({ headers: user.headers })).toEqual({ count: 1 })
        const list = await app.request('/notification/list', user.headers)
        expect(list.headers.get('cache-control')).toContain('no-store')
        const listed = await list.json()
        expect(listed.notifications[0]).not.toHaveProperty('idempotencyKey')
        expect(listed.notifications[0]).not.toHaveProperty('recipient')

        await app.auth.api.setNotificationArchived({ headers: user.headers, body: { id, archived: true } })
        expect(await app.auth.api.getUnreadNotificationCount({ headers: user.headers })).toEqual({ count: 0 })
        expect((await app.auth.api.listNotifications({ headers: user.headers, query: {} })).total).toBe(0)
        expect(
            (await app.auth.api.listNotifications({ headers: user.headers, query: { archived: 'archived' } }))
                .notifications[0]?.readAt,
        ).toBeNull()
        await app.auth.api.setNotificationArchived({ headers: user.headers, body: { id, archived: true } })
        expect(onArchiveStateChanged).toHaveBeenCalledTimes(1)
        await app.auth.api.setNotificationArchived({ headers: user.headers, body: { id, archived: false } })

        const reads = await Promise.all(
            Array.from({ length: 8 }, () =>
                app.auth.api.setNotificationRead({ headers: user.headers, body: { id, read: true } }),
            ),
        )
        expect(reads.filter((result) => result.changed)).toHaveLength(1)
        expect(onReadStateChanged).toHaveBeenCalledTimes(1)
        const readAt = reads[0]!.notification.readAt
        expect(
            (await app.auth.api.setNotificationRead({ headers: user.headers, body: { id, read: true } })).notification
                .readAt,
        ).toEqual(readAt)
        await app.auth.api.setNotificationRead({ headers: user.headers, body: { id, read: false } })
        expect(onReadStateChanged).toHaveBeenCalledTimes(2)
        expect(await app.auth.api.getUnreadNotificationCount({ headers: user.headers })).toEqual({ count: 1 })
    })

    it('enforces authentication, ownership, absent send HTTP routes, and user deletion', async () => {
        const app = await setup()
        cleanups.push(app.close)
        const owner = await app.user()
        const other = await app.user()
        const sent = await app.auth.api.sendNotification({
            body: { recipients: [owner.id], idempotencyKey: 'private', notification: content },
        })
        const result = sent.results[0]!
        if (result.status !== 'created') throw new Error('Expected created')
        for (const path of ['/notification/list', '/notification/unread-count']) {
            expect((await app.request(path)).status).toBe(401)
        }
        expect(
            (await app.request('/notification/set-read', new Headers(), { id: result.notification.id, read: true }))
                .status,
        ).toBe(401)
        expect(
            (await app.request('/notification/set-read', other.headers, { id: result.notification.id, read: true }))
                .status,
        ).toBe(404)
        expect(
            (
                await app.request('/notification/set-archived', other.headers, {
                    id: result.notification.id,
                    archived: true,
                })
            ).status,
        ).toBe(404)
        expect((await app.auth.api.listNotifications({ headers: other.headers, query: {} })).notifications).toEqual([])
        for (const path of ['/notification/send', '/notification/send-notification', '/send-notification']) {
            expect(
                (
                    await app.request(path, owner.headers, {
                        recipients: [other.id],
                        idempotencyKey: 'attack',
                        notification: content,
                    })
                ).status,
            ).toBe(404)
        }
        expect(app.auth.api.sendNotification.path).toBeFalsy()
        await app.ctx.adapter.delete({ model: 'user', where: [{ field: 'id', value: owner.id }] })
        expect(await app.ctx.adapter.count({ model: 'notification' })).toBe(0)
    })

    it('deduplicates across database connections and restarts and rejects changed content', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'notification-'))
        cleanups.push(() => rm(directory, { recursive: true, force: true }))
        const filename = join(directory, 'auth.db')
        const hook = vi.fn<NonNullable<NotificationOptions['onNotificationCreated']>>()
        const first = await setup({ onNotificationCreated: hook }, filename)
        cleanups.push(first.close)
        const second = await setup({ onNotificationCreated: hook }, filename)
        cleanups.push(second.close)
        const user = await first.user()
        const body = {
            recipients: [user.id],
            idempotencyKey: 'same',
            notification: { ...content, data: { a: 1, nested: { b: 2, c: 3 } } },
        }
        const results = await Promise.all(
            Array.from({ length: 12 }, (_, index) => (index % 2 ? first : second).auth.api.sendNotification({ body })),
        )
        expect(
            results.flatMap((result) => result.results).filter((result) => result.status === 'created'),
        ).toHaveLength(1)
        expect(
            results.flatMap((result) => result.results).filter((result) => result.status === 'duplicate'),
        ).toHaveLength(11)
        expect(hook).toHaveBeenCalledTimes(1)
        expect(await first.ctx.adapter.count({ model: 'notification' })).toBe(1)
        first.close()
        second.close()
        const restarted = await setup({ onNotificationCreated: hook }, filename)
        cleanups.push(restarted.close)
        const again = await restarted.auth.api.sendNotification({
            body: { ...body, notification: { ...content, data: { nested: { c: 3, b: 2 }, a: 1 } } },
        })
        expect(again.results[0]?.status).toBe('duplicate')
        const conflict = await restarted.auth.api.sendNotification({
            body: { ...body, notification: { ...content, title: 'Different' } },
        })
        expect(conflict.results[0]).toMatchObject({
            status: 'failed',
            error: { code: 'NOTIFICATION_IDEMPOTENCY_CONFLICT' },
        })
        expect(hook).toHaveBeenCalledTimes(1)
    })

    it('keeps saved notifications and state when hooks fail without retrying hooks', async () => {
        const failing = vi.fn<() => void>(() => {
            throw new Error('provider credential must stay private')
        })
        const app = await setup({
            onNotificationCreated: failing,
            onReadStateChanged: failing,
            onArchiveStateChanged: failing,
        })
        cleanups.push(app.close)
        const user = await app.user()
        const body = { recipients: [user.id], idempotencyKey: 'hook-failure', notification: content }
        const first = await app.auth.api.sendNotification({ body })
        const item = first.results[0]!
        if (item.status !== 'created') throw new Error('Expected saved notification')
        expect(item.hook).toBe('failed')
        expect((await app.auth.api.sendNotification({ body })).results[0]?.status).toBe('duplicate')
        expect(failing).toHaveBeenCalledTimes(1)
        const updated = await app.request('/notification/set-read', user.headers, {
            id: item.notification.id,
            read: true,
        })
        expect(updated.status).toBe(200)
        expect(await updated.text()).not.toContain('credential')
        const archived = await app.auth.api.setNotificationArchived({
            headers: user.headers,
            body: { id: item.notification.id, archived: true },
        })
        expect(archived).toMatchObject({ changed: true, hook: 'failed' })
        expect(archived.notification.readAt).toBeInstanceOf(Date)
        expect(archived.notification.archivedAt).toBeInstanceOf(Date)
        expect(failing).toHaveBeenCalledTimes(3)
    })
})
