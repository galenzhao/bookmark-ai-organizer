// SPDX-License-Identifier: Apache-2.0
import { BookmarkManager } from '../utils/bookmark-manager';
import type { BookmarkCreationResult, BookmarkMoveResult } from '../utils/bookmark-manager';
import { LlmClassifier } from '../utils/llm-classifier';
import type { ClassificationResultWithMeta } from '../utils/llm-classifier';
import { SecurityManager } from '../utils/security';
import {
    fetchOpenRouterModels,
    getProviderPreference,
    getSelectedOpenRouterModel,
} from '../utils/openrouter';

type RuntimeRequest = {
    action: string;
    data?: unknown;
};

type RuntimeSuccess<T> = { success: true; result: T };
type RuntimeFailure = { success: false; error: string };
type RuntimeResponse<T> = RuntimeSuccess<T> | RuntimeFailure;

type SettingsState = {
    hasApiKey: boolean;
    apiKeyHint: string | null;
    providerPreference: string | null;
    selectedOpenRouterModel: string | null;
    autoClassifyEnabled: boolean;
};

type ClassifyAndSavePayload = {
    url: string;
    title: string;
};

type ReclassifyPayload = {
    bookmarkId: string;
    modelOverride?: string;
};

type ClassifyResultPayload = {
    bookmark: chrome.bookmarks.BookmarkTreeNode;
    folderPath: string[];
    previousFolderPath?: string[];
    folderId: string;
    title: string;
    url: string;
    tags: string[];
    confidence: number;
    provider: string;
    providerId: string;
    model: string;
    action: 'created' | 'moved';
};

const AUTO_CLASSIFY_KEY = 'auto_classify_enabled';
const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);
const MAX_TITLE_LENGTH = 300;
const MAX_MODEL_LENGTH = 150;

class BackgroundService {
    private readonly bookmarkManager = new BookmarkManager();
    private readonly classifier = new LlmClassifier();
    private readonly pendingInternalBookmarkFingerprints = new Set<string>();

    constructor() {
        this.initializeListeners();
    }

    private initializeListeners(): void {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            void this.routeMessage(request, sender).then(sendResponse);
            return true;
        });

        chrome.runtime.onInstalled.addListener(() => {
            void this.ensureDefaultSettings();
        });

        chrome.bookmarks.onCreated.addListener((bookmarkId, bookmark) => {
            void this.handleAutoClassifyBookmark(bookmarkId, bookmark);
        });

        globalThis.addEventListener('unhandledrejection', () => {
            // Keep service worker alive and avoid silent failures.
        });
    }

    private async routeMessage(
        request: unknown,
        sender: chrome.runtime.MessageSender,
    ): Promise<RuntimeResponse<unknown>> {
        try {
            if (!this.isRuntimeRequest(request)) {
                return this.failure('Invalid request payload.');
            }
            if (sender.id && sender.id !== chrome.runtime.id) {
                return this.failure('Unauthorized request sender.');
            }

            switch (request.action) {
                case 'SAVE_API_KEY':
                    return this.success(await this.handleSaveApiKey(request.data));
                case 'GET_SETTINGS_STATE':
                    return this.success(await this.getSettingsState());
                case 'GET_OPENROUTER_MODELS':
                    return this.success(await this.handleGetOpenRouterModels(request.data));
                case 'CLASSIFY_AND_SAVE':
                    return this.success(await this.handleClassifyAndSave(request.data));
                case 'CLASSIFY_ONLY':
                    return this.success(await this.handleClassifyOnly(request.data));
                case 'RECLASSIFY_BOOKMARK':
                    return this.success(await this.handleReclassifyBookmark(request.data));
                case 'SET_AUTO_CLASSIFY':
                    return this.success(await this.handleSetAutoClassify(request.data));
                default:
                    return this.failure('Unknown action.');
            }
        } catch (error: unknown) {
            return this.failure(this.errorMessage(error));
        }
    }

    private async handleSaveApiKey(data: unknown): Promise<SettingsState> {
        const payload = this.ensureObject(data);
        const apiKey = this.ensureString(payload.apiKey, 'API key');
        await SecurityManager.storeApiKey(apiKey);
        return this.getSettingsState();
    }

    private async handleGetOpenRouterModels(data: unknown): Promise<{ models: { id: string; name?: string }[] }> {
        const payload = this.ensureObject(data ?? {});
        const forceRefresh = payload.forceRefresh === true;
        const apiKey = await SecurityManager.getApiKey();
        if (!apiKey) {
            throw new Error('Save an API key before loading OpenRouter models.');
        }

        const models = await fetchOpenRouterModels(apiKey, forceRefresh);
        return {
            models: models.map((model) => ({ id: model.id, name: model.name })),
        };
    }

    private async handleClassifyAndSave(data: unknown): Promise<ClassifyResultPayload> {
        const payload = this.normalizeClassifyPayload(data);
        const classification = await this.classify(payload.url, payload.title, undefined);

        const fingerprint = this.fingerprint(payload.url, payload.title);
        this.pendingInternalBookmarkFingerprints.add(fingerprint);

        let created: BookmarkCreationResult;
        try {
            created = await this.bookmarkManager.createBookmark(
                payload.url,
                payload.title,
                classification.folderPath,
            );
        } finally {
            setTimeout(() => {
                this.pendingInternalBookmarkFingerprints.delete(fingerprint);
            }, 5000);
        }

        return this.buildCreatePayload(created, classification, payload.url);
    }

    private async handleClassifyOnly(data: unknown): Promise<Omit<ClassifyResultPayload, 'bookmark' | 'folderId' | 'action'>> {
        const payload = this.normalizeClassifyPayload(data);
        const classification = await this.classify(payload.url, payload.title, undefined);
        return {
            folderPath: classification.folderPath,
            title: payload.title,
            url: payload.url,
            tags: classification.tags,
            confidence: classification.confidence,
            provider: classification.providerName,
            providerId: classification.providerId,
            model: classification.model,
        };
    }

    private async handleReclassifyBookmark(data: unknown): Promise<ClassifyResultPayload> {
        const payload = this.ensureObject(data);
        const bookmarkId = this.ensureString(payload.bookmarkId, 'Bookmark ID');
        const modelOverride = payload.modelOverride === undefined
            ? undefined
            : this.ensureModel(payload.modelOverride);

        const [bookmark] = await chrome.bookmarks.get(bookmarkId);
        if (!bookmark || !bookmark.url) {
            throw new Error('Bookmark is missing or cannot be classified.');
        }

        const title = bookmark.title || bookmark.url;
        const classification = await this.classify(
            bookmark.url,
            title,
            modelOverride,
        );
        const moved = await this.bookmarkManager.moveBookmarkToFolderPath(
            bookmark.id,
            classification.folderPath,
        );

        return this.buildMovePayload(moved, classification, bookmark.url);
    }

    private async handleSetAutoClassify(data: unknown): Promise<{ autoClassifyEnabled: boolean }> {
        const payload = this.ensureObject(data);
        const enabled = payload.enabled === true;
        await chrome.storage.local.set({ [AUTO_CLASSIFY_KEY]: enabled });
        return { autoClassifyEnabled: enabled };
    }

    private async getSettingsState(): Promise<SettingsState> {
        const hasApiKey = await SecurityManager.hasApiKey();
        const [apiKeyHint, providerPreference, selectedOpenRouterModel, autoClassifyEnabled] = await Promise.all([
            SecurityManager.getApiKeyHint(),
            getProviderPreference(),
            getSelectedOpenRouterModel(),
            this.getAutoClassifyEnabled(),
        ]);

        return {
            hasApiKey,
            apiKeyHint,
            providerPreference,
            selectedOpenRouterModel,
            autoClassifyEnabled,
        };
    }

    private async classify(
        url: string,
        title: string,
        modelOverride?: string,
    ): Promise<ClassificationResultWithMeta> {
        const options = modelOverride
            ? { providerOverride: 'openrouter', modelOverride }
            : {};
        return this.classifier.classifyUrlWithMeta(url, title, options);
    }

    private async handleAutoClassifyBookmark(
        _bookmarkId: string,
        bookmark: chrome.bookmarks.BookmarkTreeNode,
    ): Promise<void> {
        if (!bookmark.url || !bookmark.id) {
            return;
        }
        if (!this.isSupportedUrl(bookmark.url)) {
            return;
        }
        if (!await this.getAutoClassifyEnabled()) {
            return;
        }

        const fingerprint = this.fingerprint(bookmark.url, bookmark.title || bookmark.url);
        if (this.pendingInternalBookmarkFingerprints.has(fingerprint)) {
            this.pendingInternalBookmarkFingerprints.delete(fingerprint);
            return;
        }

        if (!await SecurityManager.hasApiKey()) {
            return;
        }

        try {
            const classification = await this.classifier.classifyUrlWithMeta(
                bookmark.url,
                bookmark.title || bookmark.url,
            );
            await this.bookmarkManager.moveBookmarkToFolderPath(bookmark.id, classification.folderPath);
        } catch {
            // Silent fail to avoid spamming users when auto-classification cannot run.
        }
    }

    private buildCreatePayload(
        result: BookmarkCreationResult,
        classification: ClassificationResultWithMeta,
        fallbackUrl: string,
    ): ClassifyResultPayload {
        return {
            bookmark: result.bookmark,
            folderPath: result.folderPath,
            folderId: result.folderId,
            title: result.bookmark.title || '',
            url: result.bookmark.url || fallbackUrl,
            tags: classification.tags,
            confidence: classification.confidence,
            provider: classification.providerName,
            providerId: classification.providerId,
            model: classification.model,
            action: 'created',
        };
    }

    private buildMovePayload(
        result: BookmarkMoveResult,
        classification: ClassificationResultWithMeta,
        fallbackUrl: string,
    ): ClassifyResultPayload {
        return {
            bookmark: result.bookmark,
            folderPath: result.folderPath,
            previousFolderPath: result.previousFolderPath,
            folderId: result.folderId,
            title: result.bookmark.title || '',
            url: result.bookmark.url || fallbackUrl,
            tags: classification.tags,
            confidence: classification.confidence,
            provider: classification.providerName,
            providerId: classification.providerId,
            model: classification.model,
            action: 'moved',
        };
    }

    private normalizeClassifyPayload(data: unknown): ClassifyAndSavePayload {
        const payload = this.ensureObject(data);
        const url = this.ensureUrl(payload.url);
        const title = this.ensureTitle(payload.title);
        return { url, title };
    }

    private ensureUrl(value: unknown): string {
        const url = this.ensureString(value, 'URL');
        if (!this.isSupportedUrl(url)) {
            throw new Error('Only http(s) URLs can be classified.');
        }
        return url;
    }

    private ensureTitle(value: unknown): string {
        const title = this.ensureString(value, 'Title').trim();
        if (!title) {
            throw new Error('Title is required.');
        }
        return title.slice(0, MAX_TITLE_LENGTH);
    }

    private ensureModel(value: unknown): string {
        const model = this.ensureString(value, 'Model override').trim();
        if (!model || model.length > MAX_MODEL_LENGTH) {
            throw new Error('Model override is invalid.');
        }
        return model;
    }

    private ensureString(value: unknown, label: string): string {
        if (typeof value !== 'string') {
            throw new Error(`${label} must be a string.`);
        }
        return value;
    }

    private ensureObject(value: unknown): Record<string, unknown> {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('Request payload must be an object.');
        }
        return value as Record<string, unknown>;
    }

    private isRuntimeRequest(value: unknown): value is RuntimeRequest {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return false;
        }
        const candidate = value as RuntimeRequest;
        return typeof candidate.action === 'string' && candidate.action.length > 0;
    }

    private async getAutoClassifyEnabled(): Promise<boolean> {
        const state = await chrome.storage.local.get(AUTO_CLASSIFY_KEY);
        return state[AUTO_CLASSIFY_KEY] === true;
    }

    private async ensureDefaultSettings(): Promise<void> {
        const existing = await chrome.storage.local.get(AUTO_CLASSIFY_KEY);
        if (typeof existing[AUTO_CLASSIFY_KEY] !== 'boolean') {
            await chrome.storage.local.set({ [AUTO_CLASSIFY_KEY]: false });
        }
    }

    private isSupportedUrl(value: string): boolean {
        try {
            const parsed = new URL(value);
            return SUPPORTED_PROTOCOLS.has(parsed.protocol);
        } catch {
            return false;
        }
    }

    private fingerprint(url: string, title: string): string {
        return `${url}::${title}`;
    }

    private success<T>(result: T): RuntimeSuccess<T> {
        return { success: true, result };
    }

    private failure(error: string): RuntimeFailure {
        return { success: false, error };
    }

    private errorMessage(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }
        return 'Unknown error occurred.';
    }
}

new BackgroundService();