import { SecurityManager } from '../src/utils/security';

type StorageRecord = Record<string, unknown>;

describe('SecurityManager', () => {
    let localStore: StorageRecord;
    let syncStore: StorageRecord;

    beforeEach(() => {
        localStore = {};
        syncStore = {};

        if (typeof globalThis.atob !== 'function') {
            (globalThis as any).atob = (value: string) => Buffer.from(value, 'base64').toString('utf8');
        }

        (globalThis as any).chrome = {
            storage: {
                local: createStorageArea(localStore),
                sync: createStorageArea(syncStore),
            },
        };
    });

    test('stores a validated API key in local storage', async () => {
        await SecurityManager.storeApiKey('  sk-test-1234567890  ');

        expect(localStore.api_key).toBe('sk-test-1234567890');
        expect(syncStore.encrypted_api_key).toBeUndefined();
    });

    test('migrates legacy sync key into local storage', async () => {
        syncStore.encrypted_api_key = Buffer.from('sk-legacy-123456789').toString('base64');

        const key = await SecurityManager.getApiKey();

        expect(key).toBe('sk-legacy-123456789');
        expect(localStore.api_key).toBe('sk-legacy-123456789');
        expect(syncStore.encrypted_api_key).toBeUndefined();
    });

    test('drops malformed legacy keys safely', async () => {
        syncStore.encrypted_api_key = '*not-base64*';
        const key = await SecurityManager.getApiKey();

        expect(key).toBeNull();
        expect(syncStore.encrypted_api_key).toBeUndefined();
    });

    test('returns key presence and hint without exposing full key', async () => {
        localStore.api_key = 'sk-demo-123456789';

        await expect(SecurityManager.hasApiKey()).resolves.toBe(true);
        await expect(SecurityManager.getApiKeyHint()).resolves.toBe('ends with 6789');
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
