import {
    fetchOpenRouterModels,
    getCachedModels,
} from '../src/utils/openrouter';

type StorageRecord = Record<string, unknown>;

describe('openrouter utils', () => {
    let localStore: StorageRecord;
    let syncStore: StorageRecord;
    let fetchMock: jest.Mock;

    beforeEach(() => {
        localStore = {};
        syncStore = {};
        fetchMock = jest.fn();

        (globalThis as any).chrome = {
            storage: {
                local: createStorageArea(localStore),
                sync: createStorageArea(syncStore),
            },
        };
        (globalThis as any).fetch = fetchMock;
    });

    test('returns fresh cached models without network request', async () => {
        localStore.openrouter_models_cache = {
            updatedAt: Date.now(),
            models: [{ id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini' }],
        };

        const models = await fetchOpenRouterModels('sk-or-v1-test');

        expect(models).toHaveLength(1);
        expect(models[0].id).toBe('openai/gpt-4o-mini');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('retries on rate limit and then succeeds', async () => {
        fetchMock
            .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                data: [{ id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini' }],
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }));

        const models = await fetchOpenRouterModels('sk-or-v1-test', true);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(models).toHaveLength(1);
        expect(models[0].id).toBe('openai/gpt-4o-mini');
    });

    test('falls back to stale cache when network fails', async () => {
        localStore.openrouter_models_cache = {
            updatedAt: Date.now() - 1000 * 60 * 60,
            models: [{ id: 'anthropic/claude-3.5-sonnet', name: 'Claude Sonnet' }],
        };
        fetchMock.mockRejectedValue(new Error('network down'));

        const models = await fetchOpenRouterModels('sk-or-v1-test', true);

        expect(models).toHaveLength(1);
        expect(models[0].id).toBe('anthropic/claude-3.5-sonnet');
        await expect(getCachedModels()).resolves.toEqual(localStore.openrouter_models_cache);
    });

    test('throws on unauthorized API key', async () => {
        fetchMock.mockResolvedValue(new Response('unauthorized', { status: 401 }));
        await expect(fetchOpenRouterModels('bad-key', true)).rejects.toThrow('Invalid OpenRouter API key');
    });
});

function createStorageArea(store: StorageRecord) {
    return {
        async get(key: string | string[]) {
            if (Array.isArray(key)) {
                return key.reduce<Record<string, unknown>>((acc, item) => {
                    acc[item] = store[item];
                    return acc;
                }, {});
            }
            return { [key]: store[key] };
        },
        async set(values: Record<string, unknown>) {
            Object.assign(store, values);
        },
        async remove(key: string | string[]) {
            if (Array.isArray(key)) {
                key.forEach((item) => delete store[item]);
                return;
            }
            delete store[key];
        },
    };
}
