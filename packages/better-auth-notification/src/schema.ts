import type { BetterAuthPluginDBSchema } from '@better-auth/core/db'
import * as z from 'zod'

export const identifier = z.string().min(1).max(256)

function isSafeHref(value: string) {
    // oxlint-disable-next-line no-control-regex -- Reject URL controls before the URL parser normalizes them.
    if (value !== value.trim() || /[\u0000-\u0020\\]/u.test(value)) return false
    if (value.startsWith('/')) return !value.startsWith('//')
    if (!/^https?:\/\//iu.test(value)) return false
    try {
        const url = new URL(value)
        return !url.username && !url.password
    } catch {
        return false
    }
}

export const actionSchema = z.object({
    id: identifier,
    label: z.string().min(1).max(200),
    href: z.string().max(2048).refine(isSafeHref, 'Use an app path or an HTTP(S) URL').optional(),
})

export const contentSchema = z.object({
    type: z.string().min(1).max(100),
    title: z.string().min(1).max(500),
    body: z.string().max(10_000).nullable().default(null),
    data: z.record(z.string(), z.json()).default({}),
    actions: z
        .array(actionSchema)
        .max(10)
        .default([])
        .refine(
            (actions) => new Set(actions.map((action) => action.id)).size === actions.length,
            'Action IDs must be unique within a notification',
        ),
})

export const listQuerySchema = z.object({
    limit: z.coerce.number<number>().int().min(1).max(100).default(20),
    offset: z.coerce.number<number>().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    read: z.enum(['all', 'read', 'unread']).default('all'),
    archived: z.enum(['all', 'archived', 'unarchived']).default('unarchived'),
})

export const schema = {
    notification: {
        fields: {
            userId: { type: 'string', required: true, references: { model: 'user', field: 'id', onDelete: 'cascade' } },
            idempotencyKey: { type: 'string', required: true, returned: false },
            type: { type: 'string', required: true },
            title: { type: 'string', required: true },
            body: { type: 'string', required: false },
            data: { type: 'json', required: true },
            actions: { type: 'json', required: true },
            createdAt: { type: 'date', required: true },
            readAt: { type: 'date', required: false },
            archivedAt: { type: 'date', required: false },
        },
        indexes: [{ fields: ['userId', 'idempotencyKey'], unique: true }, { fields: ['userId', 'createdAt'] }],
    },
} satisfies BetterAuthPluginDBSchema

export type NotificationAction = z.infer<typeof actionSchema>
export type NotificationInput = z.input<typeof contentSchema>
export type NotificationContent = z.output<typeof contentSchema>
export type NotificationListQuery = z.input<typeof listQuerySchema>
