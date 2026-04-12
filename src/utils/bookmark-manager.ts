// SPDX-License-Identifier: Apache-2.0
export interface BookmarkCreationResult {
    bookmark: chrome.bookmarks.BookmarkTreeNode;
    folderPath: string[];
    folderId: string;
}

export interface BookmarkMoveResult {
    bookmark: chrome.bookmarks.BookmarkTreeNode;
    previousFolderPath: string[];
    folderPath: string[];
    folderId: string;
}

export class BookmarkManager {
    async createBookmark(url: string, title: string, folderPath: string[]): Promise<BookmarkCreationResult> {
        const normalizedPath = folderPath
            .map(segment => segment.trim())
            .filter(Boolean)
            .slice(0, 3);
        const folderId = await this.ensureFolderPath(normalizedPath);
        const bookmark = await chrome.bookmarks.create({
            parentId: folderId,
            title,
            url
        });

        return {
            bookmark,
            folderPath: normalizedPath,
            folderId,
        };
    }

    async moveBookmarkToFolderPath(bookmarkId: string, folderPath: string[]): Promise<BookmarkMoveResult> {
        const normalizedPath = this.normalizePath(folderPath);
        const existingBookmark = await this.getBookmark(bookmarkId);
        if (!existingBookmark.url) {
            throw new Error('Only URL bookmarks can be re-classified.');
        }

        const previousFolderPath = await this.getBookmarkPath(bookmarkId);
        const folderId = await this.ensureFolderPath(normalizedPath);
        const bookmark = await chrome.bookmarks.move(bookmarkId, { parentId: folderId });

        return {
            bookmark,
            previousFolderPath,
            folderPath: normalizedPath,
            folderId,
        };
    }

    async getBookmarkPath(bookmarkId: string): Promise<string[]> {
        const bookmark = await this.getBookmark(bookmarkId);
        let parentId = bookmark.parentId;
        const path: string[] = [];

        while (parentId) {
            const [parent] = await chrome.bookmarks.get(parentId);
            if (!parent) {
                break;
            }
            if (parent.id === '0') {
                break;
            }

            if (parent.title) {
                path.unshift(parent.title);
            }
            parentId = parent.parentId;
        }

        return path;
    }

    private async ensureFolderPath(path: string[]): Promise<string> {
        let currentId = '1'; // Bookmarks menu ID
        for (const folderName of path) {
            const existingFolder = await this.findFolder(currentId, folderName);
            if (existingFolder) {
                currentId = existingFolder.id;
            } else {
                const newFolder = await chrome.bookmarks.create({
                    parentId: currentId,
                    title: folderName
                });
                currentId = newFolder.id;
            }
        }
        return currentId;
    }

    private async findFolder(parentId: string, name: string): Promise<chrome.bookmarks.BookmarkTreeNode | null> {
        const children = await chrome.bookmarks.getChildren(parentId);
        return children.find(child => child.title === name && !child.url) || null;
    }

    private async getBookmark(bookmarkId: string): Promise<chrome.bookmarks.BookmarkTreeNode> {
        const [bookmark] = await chrome.bookmarks.get(bookmarkId);
        if (!bookmark) {
            throw new Error('Bookmark not found.');
        }
        return bookmark;
    }

    private normalizePath(folderPath: string[]): string[] {
        const normalizedPath = folderPath
            .map(segment => segment.trim())
            .filter(Boolean)
            .slice(0, 3);
        if (!normalizedPath.length) {
            throw new Error('A target folder path is required.');
        }
        return normalizedPath;
    }
}