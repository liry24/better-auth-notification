import type { BetterFetchOption } from '@better-fetch/fetch'
/* oxlint-disable typescript/no-unsafe-type-assertion -- Better Auth inference markers and its untyped client store require narrowing. */
import type { BetterAuthClientPlugin } from 'better-auth'
import { useAuthQuery } from 'better-auth/client'
import type { AuthQueryAtom, AuthQueryState } from 'better-auth/client'
import { atom, onMount } from 'nanostores'
import type { WritableAtom } from 'nanostores'

import type { notification } from './index'
import type { NotificationListQuery } from './schema'
import type { NotificationList } from './types'

export type { NotificationAction, NotificationInput, NotificationListQuery } from './schema'
export type { HookStatus, Notification, NotificationList } from './types'

export function notificationClient() {
    return {
        id: 'notification',
        $InferServerPlugin: {} as ReturnType<typeof notification>,
        getAtoms($fetch) {
            const signal = atom(false)
            const epoch = atom(0)
            const query = atom<NotificationListQuery>({})
            // Ignore responses started under a previous signed-in user.
            const scopedFetch = ((url: string, options?: BetterFetchOption) => {
                const started = epoch.get()
                return $fetch(url, {
                    ...options,
                    onSuccess: (event) => (started === epoch.get() ? options?.onSuccess?.(event) : undefined),
                    onError: (event) => (started === epoch.get() ? options?.onError?.(event) : undefined),
                    onRequest: (event) => (started === epoch.get() ? options?.onRequest?.(event) : undefined),
                }).catch((error: unknown) => {
                    if (started !== epoch.get()) return { data: null, error: null }
                    throw error
                })
            }) as typeof $fetch
            return {
                $notificationSignal: signal,
                $notificationEpoch: epoch,
                $notificationQuery: query,
                notifications: useAuthQuery<NotificationList>(signal, '/notification/list', scopedFetch, () => ({
                    method: 'GET',
                    query: query.get(),
                })),
                unreadNotificationCount: useAuthQuery<{ count: number }>(
                    signal,
                    '/notification/unread-count',
                    scopedFetch,
                    { method: 'GET' },
                ),
            }
        },
        getActions(_$fetch, store) {
            const list = store.atoms.notifications as AuthQueryAtom<NotificationList>
            const count = store.atoms.unreadNotificationCount as AuthQueryAtom<{ count: number }>
            const epoch = store.atoms.$notificationEpoch as WritableAtom<number>
            const query = store.atoms.$notificationQuery as WritableAtom<NotificationListQuery>
            const signal = store.atoms.$notificationSignal as WritableAtom<boolean>
            const session = store.atoms.session as WritableAtom<AuthQueryState<{ user: { id: string } }>>
            const reset = () => {
                epoch.set(epoch.get() + 1)
                query.set({})
                list.set({ ...list.get(), data: null, error: null, isPending: true, isRefetching: false })
                count.set({ ...count.get(), data: null, error: null, isPending: true, isRefetching: false })
            }
            onMount(signal, () => {
                let userId: string | null | undefined
                return session.subscribe((state) => {
                    if (state.isPending) return
                    const next = state.data?.user.id ?? null
                    if (next !== userId) {
                        userId = next
                        reset()
                        store.notify('$notificationSignal')
                    }
                })
            })
            store.listen('$sessionSignal', () => {
                reset()
                store.notify('$notificationSignal')
            })
            return {
                notification: {
                    async refetch(nextQuery?: NotificationListQuery) {
                        if (nextQuery) query.set(nextQuery)
                        await Promise.all([list.get().refetch(), count.get().refetch()])
                    },
                },
            }
        },
        atomListeners: [
            {
                matcher: (path) => path === '/notification/set-read' || path === '/notification/set-archived',
                signal: '$notificationSignal',
            },
        ],
    } satisfies BetterAuthClientPlugin
}
