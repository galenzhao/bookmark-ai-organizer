// SPDX-License-Identifier: Apache-2.0
export class SecurityManager {
    private static readonly STORAGE_KEY = 'api_key';
    private static readonly LEGACY_STORAGE_KEY = 'encrypted_api_key';
    private static readonly MAX_KEY_LENGTH = 512;

    private static normalizeApiKey(apiKey: string): string {
        return apiKey.trim();
    }

    private static validateApiKey(apiKey: string): void {
        if (!apiKey) {
            throw new Error('API key is required.');
        }
        if (apiKey.length < 10) {
            throw new Error('API key looks too short.');
        }
        if (apiKey.length > this.MAX_KEY_LENGTH) {
            throw new Error('API key looks invalid.');
        }
        if (/\s/.test(apiKey)) {
            throw new Error('API key must not contain spaces.');
        }
    }

    static async storeApiKey(apiKey: string): Promise<void> {
        const normalized = this.normalizeApiKey(apiKey);
        this.validateApiKey(normalized);

        await chrome.storage.local.set({ [this.STORAGE_KEY]: normalized });
        // Best-effort cleanup of legacy synced key to reduce exposure.
        await chrome.storage.sync.remove(this.LEGACY_STORAGE_KEY);
    }

    static async getApiKey(): Promise<string | null> {
        const localKey = await this.readLocalKey();
        if (localKey) {
            return localKey;
        }

        return this.migrateLegacySyncKey();
    }

    static async hasApiKey(): Promise<boolean> {
        return Boolean(await this.getApiKey());
    }

    static async getApiKeyHint(): Promise<string | null> {
        const apiKey = await this.getApiKey();
        if (!apiKey) {
            return null;
        }

        const suffix = apiKey.slice(-4);
        return `ends with ${suffix}`;
    }

    static async clearApiKey(): Promise<void> {
        await Promise.all([
            chrome.storage.local.remove(this.STORAGE_KEY),
            chrome.storage.sync.remove(this.LEGACY_STORAGE_KEY),
        ]);
    }

    private static async readLocalKey(): Promise<string | null> {
        try {
            const localResult = await chrome.storage.local.get(this.STORAGE_KEY);
            const storedKey = localResult[this.STORAGE_KEY];
            if (typeof storedKey !== 'string' || !storedKey) {
                return null;
            }
            const normalized = this.normalizeApiKey(storedKey);
            this.validateApiKey(normalized);
            return normalized;
        } catch {
            return null;
        }
    }

    private static async migrateLegacySyncKey(): Promise<string | null> {
        try {
            const legacyResult = await chrome.storage.sync.get(this.LEGACY_STORAGE_KEY);
            const legacyEncoded = legacyResult[this.LEGACY_STORAGE_KEY];
            if (typeof legacyEncoded !== 'string' || !legacyEncoded) {
                return null;
            }

            const migrated = this.normalizeApiKey(atob(legacyEncoded));
            this.validateApiKey(migrated);

            await chrome.storage.local.set({ [this.STORAGE_KEY]: migrated });
            await chrome.storage.sync.remove(this.LEGACY_STORAGE_KEY);
            return migrated;
        } catch {
            await chrome.storage.sync.remove(this.LEGACY_STORAGE_KEY);
            return null;
        }
    }
}