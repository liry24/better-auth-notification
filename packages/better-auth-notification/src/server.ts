/* oxlint-disable no-await-in-loop -- Pagination depends on the previous cursor; sequential recipient writes bound database and hook load. */
import type { AuthContext } from '@better-auth/core'
import type { DBAdapter, Where } from '@better-auth/core/db/adapter'
import { APIError } from 'better-auth/api'

import { contentSchema } from './schema'
import type { NotificationContent } from './schema'
import type {
    HookStatus,
    Notification,
    NotificationOptions,
    RecipientAccount,
    RecipientContext,
    RecipientData,
    RecipientFilter,
    RecipientResult,
    RecipientSession,
    SendNotificationResult,
    StoredNotification,
} from './types'

export function publicNotification(value: StoredNotification): Notification {
    const { idempotencyKey: _, ...notification } = value
    return {
        ...notification,
        body: notification.body ?? null,
        readAt: notification.readAt ?? null,
        archivedAt: notification.archivedAt ?? null,
    }
}

function canonical(value: NotificationContent) {
    return JSON.stringify(value, (_key, item: unknown) => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
            return Object.fromEntries(Object.entries(item).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        }
        return item
    })
}

export async function runHook<T>(
    ctx: AuthContext,
    hook: ((event: T) => void | Promise<void>) | undefined,
    event: T,
): Promise<HookStatus> {
    if (!hook) return 'skipped'
    try {
        await hook(event)
        return 'completed'
    } catch {
        // App hook errors may contain provider credentials. Keep logs metadata-only.
        ctx.logger.error('Notification hook failed after the database write; no automatic retry is performed')
        return 'failed'
    }
}

async function related<T extends { id: string }>(
    adapter: DBAdapter,
    model: string,
    where: Where[],
    select: string[],
): Promise<T[]> {
    const rows: T[] = []
    let cursor: string | undefined
    for (;;) {
        const page = await adapter.findMany<T>({
            model,
            select,
            limit: 100,
            sortBy: { field: 'id', direction: 'asc' },
            where: [
                ...where,
                ...(cursor === undefined ? [] : [{ field: 'id', operator: 'gt' as const, value: cursor }]),
            ],
        })
        rows.push(...page)
        if (page.length < 100) return rows
        cursor = page.at(-1)?.id
    }
}

async function recipientData(ctx: AuthContext, recipientId: string): Promise<RecipientData> {
    const user = await ctx.adapter.findOne<RecipientData['user']>({
        model: 'user',
        where: [{ field: 'id', value: recipientId }],
    })
    if (!user)
        throw new APIError('NOT_FOUND', { code: 'NOTIFICATION_USER_NOT_FOUND', message: 'Recipient does not exist' })
    const where: Where[] = [{ field: 'userId', value: recipientId }]
    const [accounts, sessions] = await Promise.all([
        related<RecipientAccount>(ctx.adapter, 'account', where, [
            'id',
            'userId',
            'accountId',
            'providerId',
            'scope',
            'createdAt',
            'updatedAt',
            'accessTokenExpiresAt',
            'refreshTokenExpiresAt',
        ]),
        ctx.options.secondaryStorage
            ? ctx.internalAdapter.listSessions(recipientId, { onlyActiveSessions: true })
            : related<RecipientSession>(
                  ctx.adapter,
                  'session',
                  [...where, { field: 'expiresAt', operator: 'gt', value: new Date() }],
                  ['id', 'userId', 'createdAt', 'updatedAt', 'expiresAt', 'ipAddress', 'userAgent'],
              ),
    ])
    // Adapter output transforms can reintroduce unselected fields; project before calling app code.
    return {
        user,
        accounts: accounts.map(
            ({
                id,
                userId,
                accountId,
                providerId,
                scope,
                createdAt,
                updatedAt,
                accessTokenExpiresAt,
                refreshTokenExpiresAt,
            }) => ({
                id,
                userId,
                accountId,
                providerId,
                scope,
                createdAt,
                updatedAt,
                accessTokenExpiresAt,
                refreshTokenExpiresAt,
            }),
        ),
        sessions: sessions.map(({ id, userId, createdAt, updatedAt, expiresAt, ipAddress, userAgent }) => ({
            id,
            userId,
            createdAt,
            updatedAt,
            expiresAt,
            ipAddress,
            userAgent,
        })),
    }
}

export interface SendInput<TContext> {
    recipients: string[] | 'all'
    notification: NotificationContent
    idempotencyKey: string
    limit: number
    cursor?: string | undefined
    filter?: RecipientFilter<TContext> | undefined
}

export async function send<TContext>(
    ctx: AuthContext,
    options: NotificationOptions<TContext>,
    input: SendInput<TContext>,
): Promise<SendNotificationResult> {
    const ids =
        input.recipients === 'all'
            ? (
                  await ctx.adapter.findMany<{ id: string }>({
                      model: 'user',
                      select: ['id'],
                      limit: input.limit + 1,
                      sortBy: { field: 'id', direction: 'asc' },
                      where: input.cursor === undefined ? [] : [{ field: 'id', operator: 'gt', value: input.cursor }],
                  })
              ).map((user) => user.id)
            : [...new Set(input.recipients)]
                  .toSorted()
                  .filter((id) => input.cursor === undefined || id > input.cursor)
                  .slice(0, input.limit + 1)
    const results: RecipientResult[] = []
    // ponytail: scan at most 100 candidates per call; use application jobs and ID batches for large audiences.
    for (const userId of ids.slice(0, input.limit)) {
        try {
            results.push(await sendOne(ctx, options, input, userId))
        } catch (error) {
            const known = error instanceof APIError && error.body?.code?.startsWith('NOTIFICATION_')
            if (!known) ctx.logger.error('Notification recipient processing failed', { userId })
            results.push({
                userId,
                status: 'failed',
                error: {
                    code: known ? error.body!.code! : 'NOTIFICATION_SEND_FAILED',
                    message: known ? error.body!.message! : 'Recipient processing failed; retry this user ID',
                },
            })
        }
    }
    const hasMore = ids.length > input.limit
    return { results, hasMore, nextCursor: hasMore ? ids[input.limit - 1]! : null }
}

async function sendOne<TContext>(
    ctx: AuthContext,
    options: NotificationOptions<TContext>,
    input: SendInput<TContext>,
    userId: string,
): Promise<RecipientResult> {
    const where: Where[] = [
        { field: 'userId', value: userId },
        { field: 'idempotencyKey', value: input.idempotencyKey },
    ]
    const existing = await ctx.adapter.findOne<StoredNotification>({ model: 'notification', where })
    if (existing) return duplicate(existing, input.notification)

    const data = await recipientData(ctx, userId)
    const recipient: RecipientContext<TContext> = { ...data, context: await options.loadContext?.(data) }
    if (input.filter) {
        const matches = await input.filter(recipient)
        if (typeof matches !== 'boolean')
            throw new APIError('BAD_REQUEST', {
                code: 'NOTIFICATION_INVALID_FILTER_RESULT',
                message: 'The filter must return a boolean',
            })
        if (!matches) return { userId, status: 'skipped' }
    }

    let created: StoredNotification
    try {
        created = await ctx.adapter.create<StoredNotification>({
            model: 'notification',
            data: {
                ...input.notification,
                userId,
                idempotencyKey: input.idempotencyKey,
                createdAt: new Date(),
                readAt: null,
                archivedAt: null,
            },
        })
    } catch (error) {
        // A concurrent insert may have won the database UNIQUE constraint.
        const winner = await ctx.adapter.findOne<StoredNotification>({ model: 'notification', where })
        if (winner) return duplicate(winner, input.notification)
        throw error
    }
    const notification = publicNotification(created)
    const hook = await runHook(ctx, options.onNotificationCreated, {
        notification,
        recipient,
        idempotencyKey: input.idempotencyKey,
    })
    return { userId, status: 'created', notification, hook }
}

function duplicate(existing: StoredNotification, content: NotificationContent): RecipientResult {
    if (canonical(contentSchema.parse(existing)) !== canonical(content)) {
        throw new APIError('CONFLICT', {
            code: 'NOTIFICATION_IDEMPOTENCY_CONFLICT',
            message: 'This recipient and idempotency key already identify different content',
        })
    }
    return { userId: existing.userId, status: 'duplicate', notification: publicNotification(existing), hook: 'skipped' }
}

export async function setState<TContext>(
    ctx: AuthContext,
    options: NotificationOptions<TContext>,
    userId: string,
    id: string,
    field: 'readAt' | 'archivedAt',
    value: boolean,
) {
    const where: Where[] = [
        { field: 'id', value: id },
        { field: 'userId', value: userId },
    ]
    const timestamp = value ? new Date() : null
    const changed = await ctx.adapter.updateMany({
        model: 'notification',
        where: [...where, { field, operator: value ? 'eq' : 'ne', value: null }],
        update: { [field]: timestamp },
    })
    const row = await ctx.adapter.findOne<StoredNotification>({ model: 'notification', where })
    if (!row) throw new APIError('NOT_FOUND', { code: 'NOTIFICATION_NOT_FOUND', message: 'Notification not found' })
    let hook: HookStatus = 'skipped'
    if (changed) {
        hook =
            field === 'readAt'
                ? await runHook(ctx, options.onReadStateChanged, { notificationId: id, userId, readAt: timestamp })
                : await runHook(ctx, options.onArchiveStateChanged, {
                      notificationId: id,
                      userId,
                      archivedAt: timestamp,
                  })
    }
    return { notification: publicNotification(row), changed: changed > 0, hook }
}
