import type { Where } from '@better-auth/core/db/adapter'
import type { BetterAuthPlugin } from 'better-auth'
import { createAuthEndpoint, sessionMiddleware } from 'better-auth/api'
import * as z from 'zod'

import { contentSchema, identifier, listQuerySchema, schema } from './schema'
import { publicNotification, send, setState } from './server'
import type { NotificationList, NotificationOptions, RecipientFilter, StoredNotification } from './types'

export type { NotificationAction, NotificationInput, NotificationListQuery } from './schema'
export type {
    ArchiveStateEvent,
    HookStatus,
    Notification,
    NotificationList,
    NotificationOptions,
    ReadStateEvent,
    RecipientAccount,
    RecipientContext,
    RecipientData,
    RecipientFilter,
    RecipientResult,
    RecipientSession,
    SendNotificationResult,
} from './types'

export function notification<TContext = undefined>(options: NotificationOptions<TContext> = {}) {
    return {
        id: 'notification',
        schema,
        endpoints: {
            sendNotification: createAuthEndpoint.serverOnly(
                {
                    method: 'POST',
                    body: z.object({
                        recipients: z.union([z.array(identifier).max(10_000), z.literal('all')]),
                        notification: contentSchema,
                        idempotencyKey: identifier,
                        cursor: identifier.optional(),
                        limit: z.number().int().min(1).max(100).default(100),
                        filter: z.custom<RecipientFilter<TContext>>((value) => typeof value === 'function').optional(),
                    }),
                },
                async (ctx) => send(ctx.context, options, ctx.body),
            ),
            listNotifications: createAuthEndpoint(
                '/notification/list',
                {
                    method: 'GET',
                    query: listQuerySchema,
                    use: [sessionMiddleware],
                    metadata: { noStore: true },
                },
                async (ctx): Promise<NotificationList> => {
                    const { read, archived, limit, offset } = ctx.query
                    const where: Where[] = [{ field: 'userId', value: ctx.context.session.user.id }]
                    if (read !== 'all')
                        where.push({ field: 'readAt', operator: read === 'unread' ? 'eq' : 'ne', value: null })
                    if (archived !== 'all')
                        where.push({
                            field: 'archivedAt',
                            operator: archived === 'unarchived' ? 'eq' : 'ne',
                            value: null,
                        })
                    const [rows, total] = await Promise.all([
                        ctx.context.adapter.findMany<StoredNotification>({
                            model: 'notification',
                            where,
                            limit,
                            offset,
                            sortBy: { field: 'createdAt', direction: 'desc' },
                        }),
                        ctx.context.adapter.count({ model: 'notification', where }),
                    ])
                    return {
                        notifications: rows.map(publicNotification),
                        total,
                        nextOffset: rows.length > 0 && offset + rows.length < total ? offset + rows.length : null,
                    }
                },
            ),
            getUnreadNotificationCount: createAuthEndpoint(
                '/notification/unread-count',
                {
                    method: 'GET',
                    use: [sessionMiddleware],
                    metadata: { noStore: true },
                },
                async (ctx) => ({
                    count: await ctx.context.adapter.count({
                        model: 'notification',
                        where: [
                            { field: 'userId', value: ctx.context.session.user.id },
                            { field: 'readAt', value: null },
                            { field: 'archivedAt', value: null },
                        ],
                    }),
                }),
            ),
            setNotificationRead: createAuthEndpoint(
                '/notification/set-read',
                {
                    method: 'POST',
                    body: z.object({ id: identifier, read: z.boolean() }),
                    use: [sessionMiddleware],
                    metadata: { noStore: true },
                },
                async (ctx) =>
                    setState(ctx.context, options, ctx.context.session.user.id, ctx.body.id, 'readAt', ctx.body.read),
            ),
            setNotificationArchived: createAuthEndpoint(
                '/notification/set-archived',
                {
                    method: 'POST',
                    body: z.object({ id: identifier, archived: z.boolean() }),
                    use: [sessionMiddleware],
                    metadata: { noStore: true },
                },
                async (ctx) =>
                    setState(
                        ctx.context,
                        options,
                        ctx.context.session.user.id,
                        ctx.body.id,
                        'archivedAt',
                        ctx.body.archived,
                    ),
            ),
        },
        options,
    } satisfies BetterAuthPlugin
}

declare module '@better-auth/core' {
    interface BetterAuthPluginRegistry<AuthOptions, Options> {
        notification: { creator: typeof notification }
    }
}
