// tests/bookmark-manager.test.ts
import { BookmarkManager } from '../src/utils/bookmark-manager';

describe('BookmarkManager', () => {
    let manager: BookmarkManager;
    let createMock: jest.Mock;
    let getChildrenMock: jest.Mock;
    let getMock: jest.Mock;
    let moveMock: jest.Mock;

    beforeEach(() => {
        createMock = jest.fn();
        getChildrenMock = jest.fn();
        getMock = jest.fn();
        moveMock = jest.fn();

        (globalThis as any).chrome = {
            bookmarks: {
                create: createMock,
                getChildren: getChildrenMock,
                get: getMock,
                move: moveMock,
            },
        };
        manager = new BookmarkManager();
    });

    test('creates a bookmark in an existing folder', async () => {
        createMock.mockResolvedValue({ id: '123', title: 'Test', url: 'https://example.com' });
        getChildrenMock.mockResolvedValue([{ id: '2', title: 'Technology', url: undefined }]);

        const result = await manager.createBookmark('https://example.com', 'Test', ['Technology']);
        expect(result).toEqual({
            bookmark: { id: '123', title: 'Test', url: 'https://example.com' },
            folderPath: ['Technology'],
            folderId: '2',
        });
        expect(createMock).toHaveBeenCalledWith({
            parentId: '2',
            title: 'Test',
            url: 'https://example.com',
        });
    });

    test('creates missing nested folders before saving bookmark', async () => {
        getChildrenMock
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);
        createMock
            .mockResolvedValueOnce({ id: '10', title: 'AI' })
            .mockResolvedValueOnce({ id: '11', title: 'Research' })
            .mockResolvedValueOnce({ id: '99', title: 'Paper', url: 'https://example.com/paper' });

        const result = await manager.createBookmark('https://example.com/paper', 'Paper', ['AI', 'Research']);

        expect(result.folderId).toBe('11');
        expect(createMock).toHaveBeenNthCalledWith(1, { parentId: '1', title: 'AI' });
        expect(createMock).toHaveBeenNthCalledWith(2, { parentId: '10', title: 'Research' });
        expect(createMock).toHaveBeenNthCalledWith(3, {
            parentId: '11',
            title: 'Paper',
            url: 'https://example.com/paper',
        });
    });

    test('moves a bookmark and reports previous folder path', async () => {
        getChildrenMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
        getMock.mockImplementation(async (id: string) => {
            const nodes: Record<string, chrome.bookmarks.BookmarkTreeNode> = {
                '50': { id: '50', title: 'Old Item', url: 'https://example.com/old', parentId: '6', dateAdded: 1 },
                '6': { id: '6', title: 'Archive', parentId: '1', dateAdded: 1 },
                '1': { id: '1', title: 'Bookmarks Bar', parentId: '0', dateAdded: 1 },
                '0': { id: '0', title: 'root', dateAdded: 1 },
            };
            return [nodes[id]];
        });
        createMock
            .mockResolvedValueOnce({ id: '20', title: 'AI', parentId: '1' })
            .mockResolvedValueOnce({ id: '21', title: 'Tools', parentId: '20' });
        moveMock.mockResolvedValue({ id: '50', title: 'Old Item', url: 'https://example.com/old', parentId: '21' });

        const result = await manager.moveBookmarkToFolderPath('50', ['AI', 'Tools']);

        expect(result.previousFolderPath).toEqual(['Bookmarks Bar', 'Archive']);
        expect(result.folderPath).toEqual(['AI', 'Tools']);
        expect(moveMock).toHaveBeenCalledWith('50', { parentId: '21' });
    });

    test('throws for empty destination folder path while moving', async () => {
        getMock.mockResolvedValue([{ id: '70', title: 'Node', url: 'https://example.com' }]);
        await expect(manager.moveBookmarkToFolderPath('70', [])).rejects.toThrow('A target folder path is required.');
    });
});