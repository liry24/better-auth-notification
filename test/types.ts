import { betterAuth } from 'better-auth'
import { createAuthClient } from 'better-auth/client'
import { createAuthClient as reactClient } from 'better-auth/react'
import { createAuthClient as vueClient } from 'better-auth/vue'

import { notificationClient } from '../packages/better-auth-notification/src/client'
import { notification } from '../packages/better-auth-notification/src/index'

const auth = betterAuth({ plugins: [notification({ loadContext: () => ({ organizationIds: ['org-1'] }) })] })
const client = createAuthClient({ plugins: [notificationClient()] })
const react = reactClient({ plugins: [notificationClient()] })
const vue = vueClient({ plugins: [notificationClient()] })

export function typeContracts() {
    void auth.api.sendNotification({
        body: {
            recipients: ['one-user'],
            idempotencyKey: 'event',
            notification: { type: 'test', title: 'Test' },
            filter: ({ user, accounts, sessions, context }) =>
                user.emailVerified &&
                accounts.length >= 0 &&
                sessions.length >= 0 &&
                context?.organizationIds.includes('org-1') === true,
        },
    })
    // @ts-expect-error Missing required idempotency key.
    void auth.api.sendNotification({ body: { recipients: 'all', notification: { type: 'test', title: 'Test' } } })
    // @ts-expect-error Server-only delivery must not be inferred on the browser client.
    void client.sendNotification({ body: {} })
    void client.notification.list({ query: { read: 'unread', archived: 'unarchived', limit: 20 } })
    void client.notification.setRead({ id: 'notification', read: true })
    void client.notification.setArchived({ id: 'notification', archived: false })
    void client.notification.refetch({ read: 'all' })
    // @ts-expect-error State mutations require a boolean.
    void client.notification.setRead({ id: 'notification', read: 'yes' })
    // @ts-expect-error Only the supported filters are accepted.
    void client.notification.list({ query: { archived: 'deleted' } })
    const reactState = react.useNotifications()
    const vueState = vue.useNotifications()
    reactState.data?.notifications[0]?.actions[0]?.href?.toUpperCase()
    vueState.value.data?.notifications[0]?.title.toUpperCase()
    return { reactState, vueState }
}
