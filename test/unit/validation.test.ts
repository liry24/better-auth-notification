import { expect, it } from 'vitest'

import { contentSchema, listQuerySchema } from '../../packages/better-auth-notification/src/schema'

it('accepts navigable actions and rejects dangerous or ambiguous links', () => {
    for (const href of [
        '/billing',
        '/posts/1?tab=comments#last',
        'https://example.com/posts/1',
        'http://localhost:3000',
    ]) {
        expect(
            contentSchema.safeParse({ type: 'test', title: 'Test', actions: [{ id: 'open', label: 'Open', href }] })
                .success,
        ).toBe(true)
    }
    for (const href of [
        'javascript:alert(1)',
        'data:text/html,x',
        '//evil.test',
        '/\\evil.test',
        ' https://example.com',
        'https://a\nb.test',
        'https://user:password@example.com',
        'https:example.com',
    ]) {
        expect(
            contentSchema.safeParse({ type: 'test', title: 'Test', actions: [{ id: 'open', label: 'Open', href }] })
                .success,
        ).toBe(false)
    }
    expect(
        contentSchema.parse({ type: 'test', title: 'Test', actions: [{ id: 'modal', label: 'Change payment method' }] })
            .actions,
    ).toHaveLength(1)
})

it('validates content and query bounds without silently accepting duplicate actions', () => {
    expect(contentSchema.safeParse({ type: 'test', title: '' }).success).toBe(false)
    expect(contentSchema.safeParse({ type: 'test', title: 'Test', data: { bad: Number.NaN } }).success).toBe(false)
    expect(
        contentSchema.safeParse({
            type: 'test',
            title: 'Test',
            actions: [
                { id: 'same', label: 'A' },
                { id: 'same', label: 'B' },
            ],
        }).success,
    ).toBe(false)
    expect(listQuerySchema.safeParse({ limit: 101 }).success).toBe(false)
    expect(listQuerySchema.safeParse({ offset: -1 }).success).toBe(false)
    expect(listQuerySchema.parse({})).toEqual({ limit: 20, offset: 0, read: 'all', archived: 'unarchived' })
})
