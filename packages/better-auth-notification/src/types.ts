import type { Account, Session, User } from 'better-auth'

import type { NotificationContent } from './schema'

export type Notification = NotificationContent & {
    id: string
    userId: string
    createdAt: Date
    readAt: Date | null
    archivedAt: Date | null
}

export type RecipientAccount = Pick<
    Account,
    | 'id'
    | 'userId'
    | 'accountId'
    | 'providerId'
    | 'scope'
    | 'createdAt'
    | 'updatedAt'
    | 'accessTokenExpiresAt'
    | 'refreshTokenExpiresAt'
>
export type RecipientSession = Omit<Session, 'token'>

export interface RecipientData {
    user: User & Record<string, unknown>
    accounts: RecipientAccount[]
    sessions: RecipientSession[]
}

export type RecipientContext<TContext = undefined> = RecipientData & { context: TContext | undefined }
export type RecipientFilter<TContext = undefined> = (
    recipient: RecipientContext<TContext>,
) => boolean | Promise<boolean>
export type HookStatus = 'completed' | 'failed' | 'skipped'

export interface ReadStateEvent {
    notificationId: string
    userId: string
    readAt: Date | null
}

export interface ArchiveStateEvent {
    notificationId: string
    userId: string
    archivedAt: Date | null
}

export interface NotificationOptions<TContext = undefined> {
    loadContext?: (recipient: RecipientData) => TContext | Promise<TContext>
    onNotificationCreated?: (event: {
        notification: Notification
        recipient: RecipientContext<TContext>
        idempotencyKey: string
    }) => void | Promise<void>
    onReadStateChanged?: (event: ReadStateEvent) => void | Promise<void>
    onArchiveStateChanged?: (event: ArchiveStateEvent) => void | Promise<void>
}

export type RecipientResult =
    | { userId: string; status: 'created' | 'duplicate'; notification: Notification; hook: HookStatus }
    | { userId: string; status: 'skipped' }
    | { userId: string; status: 'failed'; error: { code: string; message: string } }

export interface SendNotificationResult {
    results: RecipientResult[]
    nextCursor: string | null
    hasMore: boolean
}

export interface NotificationList {
    notifications: Notification[]
    total: number
    nextOffset: number | null
}

export type StoredNotification = Notification & { idempotencyKey: string }
