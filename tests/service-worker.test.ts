const mockBookmarkManager = {
    createBookmark: jest.fn(),
    moveBookmarkToFolderPath: jest.fn(),
};

const mockClassifier = {
    classifyUrlWithMeta: jest.fn(),
};

const mockSecurity = {
    storeApiKey: jest.fn(),
    hasApiKey: jest.fn(),
    getApiKeyHint: jest.fn(),
    getApiKey: jest.fn(),
};

const mockOpenRouter = {
    fetchOpenRouterModels: jest.fn(),
    getProviderPreference: jest.fn(),
    getSelectedOpenRouterModel: jest.fn(),
};

jest.mock('../src/utils/bookmark-manager', () => ({
    BookmarkManager: jest.fn().mockImplementation(() => mockBookmarkManager),
}));

jest.mock('../src/utils/llm-classifier', () => ({
    LlmClassifier: jest.fn().mockImplementation(() => mockClassifier),
}));

jest.mock('../src/utils/security', () => ({
    SecurityManager: mockSecurity,
}));

jest.mock('../src/utils/openrouter', () => ({
    fetchOpenRouterModels: (...args: unknown[]) => mockOpenRouter.fetchOpenRouterModels(...args),
    getProviderPreference: (...args: unknown[]) => mockOpenRouter.getProviderPreference(...args),
    getSelectedOpenRouterModel: (...args: unknown[]) => mockOpenRouter.getSelectedOpenRouterModel(...args),
}));

describe('Background service worker runtime contract', () => {
    let onMessageListener: ((request: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => boolean) | null;
    let onCreatedListener: ((bookmarkId: string, bookmark: chrome.bookmarks.BookmarkTreeNode) => void) | null;
    let localStore: Record<string, unknown>;
    let storageSetMock: jest.Mock;

    beforeEach(async () => {
        jest.resetModules();
        jest.clearAllMocks();
        onMessageListener = null;
        onCreatedListener = null;
        localStore = {};
        storageSetMock = jest.fn(async (values: Record<string, unknown>) => {
            Object.assign(localStore, values);
        });

        (globalThis as any).chrome = {
            runtime: {
                id: 'ext-id',
                onMessage: {
                    addListener: jest.fn((listener: typeof onMessageListener) => {
                        onMessageListener = listener;
                    }),
                },
                onInstalled: {
                    addListener: jest.fn(),
                },
            },
            bookmarks: {
                onCreated: {
                    addListener: jest.fn((listener: typeof onCreatedListener) => {
                        onCreatedListener = listener;
                    }),
                },
                get: jest.fn(),
            },
            storage: {
                local: {
                    get: jest.fn(async (key: string) => ({ [key]: localStore[key] })),
                    set: storageSetMock,
                },
            },
        };

        if (typeof globalThis.addEventListener !== 'function') {
            (globalThis as any).addEventListener = jest.fn();
        } else {
            jest.spyOn(globalThis, 'addEventListener').mockImplementation(() => {});
        }

        mockSecurity.hasApiKey.mockResolvedValue(true);
        mockSecurity.getApiKeyHint.mockResolvedValue('ends with 6789');
        mockOpenRouter.getProviderPreference.mockResolvedValue('openrouter');
        mockOpenRouter.getSelectedOpenRouterModel.mockResolvedValue('openai/gpt-4o-mini');
        mockOpenRouter.fetchOpenRouterModels.mockResolvedValue([{ id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini' }]);
        mockClassifier.classifyUrlWithMeta.mockResolvedValue({
            folderPath: ['💻 Technology'],
            tags: ['coding'],
            confidence: 0.92,
            providerId: 'openrouter',
            providerName: 'OpenRouter',
            model: 'openai/gpt-4o-mini',
        });
        mockBookmarkManager.createBookmark.mockResolvedValue({
            bookmark: { id: '10', title: 'Example', url: 'https://example.com' },
            folderPath: ['💻 Technology'],
            folderId: '2',
        });
        mockBookmarkManager.moveBookmarkToFolderPath.mockResolvedValue({
            bookmark: { id: '10', title: 'Example', url: 'https://example.com' },
            previousFolderPath: ['Old'],
            folderPath: ['💻 Technology'],
            folderId: '2',
        });

        await import('../src/background/service-worker');
        expect(onMessageListener).toBeTruthy();
        expect(onCreatedListener).toBeTruthy();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('rejects malformed runtime payloads', async () => {
        const sendResponse = jest.fn();
        onMessageListener!(null, { id: 'ext-id' }, sendResponse);
        await waitForCall(sendResponse);

        expect(sendResponse).toHaveBeenCalledWith({
            success: false,
            error: 'Invalid request payload.',
        });
    });

    test('rejects unauthorized sender id', async () => {
        const sendResponse = jest.fn();
        onMessageListener!({ action: 'GET_SETTINGS_STATE' }, { id: 'foreign-extension' }, sendResponse);
        await waitForCall(sendResponse);

        expect(sendResponse).toHaveBeenCalledWith({
            success: false,
            error: 'Unauthorized request sender.',
        });
    });

    test('returns hydrated settings state', async () => {
        localStore['auto_classify_enabled'] = true;
        const sendResponse = jest.fn();
        onMessageListener!({ action: 'GET_SETTINGS_STATE' }, { id: 'ext-id' }, sendResponse);
        await waitForCall(sendResponse);

        expect(sendResponse).toHaveBeenCalledWith({
            success: true,
            result: {
                hasApiKey: true,
                apiKeyHint: 'ends with 6789',
                providerPreference: 'openrouter',
                selectedOpenRouterModel: 'openai/gpt-4o-mini',
                autoClassifyEnabled: true,
            },
        });
    });

    test('classifies and saves a bookmark through validated contract', async () => {
        jest.useFakeTimers();

        const sendResponse = jest.fn();
        onMessageListener!(
            {
                action: 'CLASSIFY_AND_SAVE',
                data: { url: 'https://example.com', title: 'Example' },
            },
            { id: 'ext-id' },
            sendResponse,
        );
        await waitForCall(sendResponse);

        expect(mockClassifier.classifyUrlWithMeta).toHaveBeenCalledWith('https://example.com', 'Example', {});
        expect(mockBookmarkManager.createBookmark).toHaveBeenCalledWith(
            'https://example.com',
            'Example',
            ['💻 Technology'],
        );
        expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({
            success: true,
            result: expect.objectContaining({
                action: 'created',
                folderPath: ['💻 Technology'],
                confidence: 0.92,
                model: 'openai/gpt-4o-mini',
            }),
        }));
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
    });

    test('persists auto-classify toggle', async () => {
        const sendResponse = jest.fn();
        onMessageListener!(
            {
                action: 'SET_AUTO_CLASSIFY',
                data: { enabled: true },
            },
            { id: 'ext-id' },
            sendResponse,
        );
        await waitForCall(sendResponse);

        expect(storageSetMock).toHaveBeenCalledWith({ auto_classify_enabled: true });
        expect(sendResponse).toHaveBeenCalledWith({
            success: true,
            result: { autoClassifyEnabled: true },
        });
    });

    test('skips auto-classify move for internal create fingerprint', async () => {
        jest.useFakeTimers();
        const sendResponse = jest.fn();
        onMessageListener!(
            {
                action: 'CLASSIFY_AND_SAVE',
                data: { url: 'https://example.com', title: 'Example' },
            },
            { id: 'ext-id' },
            sendResponse,
        );
        await waitForCall(sendResponse);

        localStore['auto_classify_enabled'] = true;
        onCreatedListener!('10', {
            id: '10',
            title: 'Example',
            url: 'https://example.com',
        } as chrome.bookmarks.BookmarkTreeNode);
        await waitForCall(jest.fn(), 2);

        expect(mockBookmarkManager.moveBookmarkToFolderPath).not.toHaveBeenCalled();
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
    });
});

async function waitForCall(mockFn: jest.Mock, maxTicks = 12): Promise<void> {
    for (let i = 0; i < maxTicks; i++) {
        if (mockFn.mock.calls.length > 0) {
            return;
        }
        await Promise.resolve();
    }
}
