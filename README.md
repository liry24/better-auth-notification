# better-auth-notification

User notifications for Better Auth, with idempotent delivery, read state, archives, and application-owned delivery hooks.

Requires **Better Auth 1.7.7–1.7.x** and **Node.js 24+**. SQLite is the verified database. The package uses Better Auth's adapter; other databases are not yet tested or guaranteed. Bun manages this repository's dependencies.

The first npm release is not published yet. Use the package preview produced by GitHub Actions, or build a local tarball:

```sh
bun install
bun run build
cd packages/better-auth-notification
bun pm pack
# In your app: bun add /absolute/path/to/better-auth-notification-0.1.0.tgz
```

## Setup

```ts
import { betterAuth } from 'better-auth'
import { notification } from 'better-auth-notification'

export const auth = betterAuth({
    // Your existing database and authentication configuration.
    plugins: [notification()],
})
```

Generate and apply the schema using the [Better Auth CLI](https://www.better-auth.com/docs/concepts/cli). The plugin adds a `notification` table, a unique index on `(userId, idempotencyKey)`, and an index on `(userId, createdAt)`. The unique constraint is required for concurrent delivery safety. Apply migrations before serving requests. User deletion cascades to their notifications.

```sh
# Built-in SQLite adapter:
bunx @better-auth/cli@1.7.7 migrate
```

## Send to one user, many users, or everyone

`sendNotification` is a **server-only** API with no HTTP route. A single recipient is a one-element array. The return shape is identical for every recipient count.

```ts
const result = await auth.api.sendNotification({
    body: {
        recipients: ['user-1'], // Multiple IDs, or 'all'.
        idempotencyKey: 'post:123:published',
        notification: {
            type: 'post.published',
            title: 'Your post is ready',
            body: 'Review the published post.',
            data: { postId: '123' },
            actions: [{ id: 'view-post', label: 'View post', href: '/posts/123' }],
        },
    },
})
```

Each result contains a `userId` and one of these statuses:

| Status      | Meaning                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| `created`   | Saved a new notification; includes `notification` and `hook`.                                                   |
| `duplicate` | The same user and key already have identical content; includes the existing notification and `hook: 'skipped'`. |
| `skipped`   | The application's filter returned `false`.                                                                      |
| `failed`    | This recipient failed; includes an error `code` and `message`. Other recipients continue.                       |

A reused key with different content produces `NOTIFICATION_IDEMPOTENCY_CONFLICT`. Existing content and read/archive state remain unchanged. JSON object key order does not affect equality; array order does. Use a new key for a new logical notification. Keys are scoped to users, so one event key can be shared across an entire campaign.

`recipients` accepts up to 10,000 IDs and removes duplicates. Results follow ID order. Each call scans **at most 100 candidates**, even when none pass the filter. Set `limit` from 1 to 100 to reduce the batch size. Continue with the returned `nextCursor`:

```ts
let cursor: string | undefined
do {
    const result = await auth.api.sendNotification({
        body: {
            recipients: 'all',
            idempotencyKey: 'maintenance:2026-10',
            notification: { type: 'maintenance', title: 'Scheduled maintenance' },
            ...(cursor === undefined ? {} : { cursor }),
            filter: ({ user, accounts }) =>
                user.emailVerified && accounts.some((account) => account.providerId === 'google'),
        },
    })
    // Record failed user IDs and inspect each created result's hook status.
    // Retry failed IDs with the same key and content, without a cursor.
    cursor = result.nextCursor ?? undefined
} while (cursor !== undefined)
```

The loop can run in your existing job system. The plugin does not run a worker or persist campaign progress. Store the cursor in your application to resume; keep the recipients, key, content and filter consistent. A batch-level error before candidates are loaded rejects the call; retry that cursor. Recipient failures are returned and advance the cursor, so retry their IDs separately.

Each batch evaluates current data. There is no audience snapshot, and new IDs behind the cursor are not revisited. For a fixed audience, save an ID list in your app and send that list in batches. Notifications already saved remain in the recipient's personal inbox if their attributes or organization membership later change.

## Recipient conditions and related data

Every new candidate loads `user`, all linked `accounts`, and all currently valid `sessions` before filtering. Filters can be synchronous or asynchronous and must return a boolean. Duplicate notifications return directly without rerunning the filter or loading related data.

- `user` includes Better Auth user fields and configured additional fields. Additional fields are typed as `unknown`; narrow them in application code.
- `accounts` includes IDs, provider, scope, creation/update dates, and token expiry dates. It excludes passwords and access/refresh/ID tokens.
- `sessions` includes IDs, creation/update/expiry dates, IP address and user agent, with no session token. When Better Auth uses secondary session storage, its session-listing API is used.
- Related rows are paginated internally; the adapter's default row limit does not truncate the context.

Use `loadContext` to add organization membership, billing, or other application data. Its return type flows into `filter` and the creation hook. `context` is optional because the loader itself is optional.

```ts
const notifications = notification({
    loadContext: async ({ user, accounts, sessions }) => ({
        verified: user.emailVerified,
        hasGoogleAccount: accounts.some((account) => account.providerId === 'google'),
        hasActiveSession: sessions.length > 0,
        // organizationIds: await yourDatabase.lookupOrganizations(user.id),
    }),
})

const auth = betterAuth({
    // Your existing database configuration.
    plugins: [notifications],
})

await auth.api.sendNotification({
    body: {
        recipients: 'all',
        idempotencyKey: 'welcome:verified',
        notification: { type: 'welcome', title: 'Welcome back' },
        filter: ({ context }) => context?.verified === true && context.hasActiveSession,
    },
})
```

Conditions run in application code after loading candidates; they are not translated into SQL. Use explicit ID batches selected by your own database for large audiences. Organization and role rules belong to the app. Recipient context is never automatically persisted in notifications or sent to the browser.

## Hooks and delivery guarantees

Configure these hooks on `notification()`:

| Hook                    | Payload                                       |
| ----------------------- | --------------------------------------------- |
| `onNotificationCreated` | `{ notification, recipient, idempotencyKey }` |
| `onReadStateChanged`    | `{ notificationId, userId, readAt }`          |
| `onArchiveStateChanged` | `{ notificationId, userId, archivedAt }`      |

Hooks run after successful database writes and are awaited. Duplicate sends and no-op state changes do not call them. Read/archive transitions are conditional database updates, so concurrent identical operations only trigger one hook. Concurrent distinct operations do not guarantee hook ordering.

```ts
notification({
    onNotificationCreated: async ({ notification, recipient }) => {
        // Use your application's mail client or durable queue here:
        // await mailQueue.enqueue({
        //     idempotencyKey: notification.id,
        //     to: recipient.user.email,
        //     subject: notification.title,
        //     text: notification.body ?? notification.title,
        // })
    },
})
```

`hook` is `completed`, `failed`, or `skipped`. A completed hook means the callback completed, not that an email reached its destination. Hook failure preserves the database write and returns `hook: 'failed'`; internal exception details are not returned to recipients. Errors are logged without callback payloads or provider credentials.

The plugin provides database idempotency, **not guaranteed external delivery**. A process can stop after saving and before invoking the hook. There is no outbox or automatic hook retry, and resending the same notification will not retry its creation hook. If durable external delivery is required, own the queue/reconciliation in your app and use the stable notification ID as the external idempotency key.

## Read state, archives, and client state

```ts
import { createAuthClient } from 'better-auth/vue' // Or /react, or /client for vanilla.
import { notificationClient } from 'better-auth-notification/client'

export const authClient = createAuthClient({ plugins: [notificationClient()] })

const { data, error } = await authClient.notification.list({
    query: { limit: 20, offset: 0, read: 'all', archived: 'unarchived' },
})
await authClient.notification.setRead({ id: 'notification-id', read: true })
await authClient.notification.setRead({ id: 'notification-id', read: false })
await authClient.notification.setArchived({ id: 'notification-id', archived: true })
await authClient.notification.setArchived({ id: 'notification-id', archived: false })
const unread = await authClient.notification.unreadCount()
```

All recipient endpoints require a session and enforce ownership in database queries. Other users' IDs behave like missing notifications. There is no administrator/broadcast HTTP endpoint.

The list returns `{ notifications, total, nextOffset }` in newest-first order. It defaults to 20 unarchived notifications; `limit` is capped at 100. Filters are `read: 'all' | 'read' | 'unread'` and `archived: 'all' | 'archived' | 'unarchived'`. Offset pagination is a live view, so new arrivals and state changes can shift page boundaries. The unread count excludes archived notifications. Archiving does not mark a notification read; unarchiving restores its previous read state.

The standard Better Auth client exposes shared query state:

```ts
// Vue: refs. React: hook state objects.
const notifications = authClient.useNotifications()
const unreadCount = authClient.useUnreadNotificationCount()

// Manual refresh, optionally changing the shared list filter/page:
await authClient.notification.refetch({ read: 'unread', archived: 'unarchived' })
```

For vanilla clients, `useNotifications` and `useUnreadNotificationCount` are subscribable atoms. Query state includes `data`, `error`, `isPending`, `isRefetching`, and `refetch`. Read/archive mutations invalidate subscribed list/count queries. Session changes clear the previous data, and late responses from a previous user are ignored. Better Auth defers its session signals briefly after auth mutations. New notifications created elsewhere need a manual refresh; no polling, SSE or WebSocket connection is installed. SSR does not automatically fetch shared queries.

## Content and actions

`type` and `title` are required. `body` defaults to `null`, JSON object `data` to `{}`, and `actions` to `[]`. Title/body are plain text for the application to render. Limits: 100 characters for type, 500 for title, 10,000 for body, 256 for IDs/idempotency keys, and 10 actions per notification.

Actions contain a unique `id`, a `label` (up to 200 characters), and an optional `href` (up to 2,048 characters). A URL must be a root-relative app path or HTTP(S) URL; protocol-relative URLs, embedded credentials, backslashes and control characters are rejected. Actions without URLs can open app-owned dialogs using their identifier. The app owns action authorization, execution, completion state and side-effect idempotency. Clicking an action does not automatically change read/archive state.

## Development and release

```sh
bun install
bun run check
bun run deps:update
```

Tooling and repository settings follow [`liria24/nuxt-files-sdk` at `fb6242a7`](https://github.com/liria24/nuxt-files-sdk/tree/fb6242a7bebb54f850d57aa937b6bc07ef0d2b97): oxfmt/oxlint with typed linting, taze, tsdown, Vitest, Knip, Sherif, pinned Actions and a required `ci-ok` gate. Nuxt-specific build/test jobs are replaced with notification integration/client tests.

Tests cover real SQLite migrations, concurrent delivery across connections, restart deduplication, access control, partial batches, hooks, related-data projection, client identity races, Vue reactivity and React SSR. Consumer tests install the packed archive with Bun/npm/pnpm and compile and run its public APIs. CI exercises Linux/Windows and minimum/latest-supported Better Auth versions.

`uppt` creates release PRs. Publishing requires successful push CI for the tagged commit and verification of the exact release archive through `NOTIFICATION_TARBALL`; the test checks that its SHA-256 stays unchanged. Configure npm trusted publishing for this repository's `release.yml` workflow and `npm` environment before the first npm release. Package previews use pkg-pr-new; format/lint suggestions use autofix.ci.
