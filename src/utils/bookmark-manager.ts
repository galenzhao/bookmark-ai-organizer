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
    async createBookmark(
        url: string,
        title: string,
        folderPath: string[],
        rootFolderId: string = '1',
    ): Promise<BookmarkCreationResult> {
        const normalizedPath = this.normalizePath(folderPath);
        const folderId = await this.ensureFolderPath(rootFolderId, normalizedPath);
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

    async moveBookmarkToFolderPath(
        bookmarkId: string,
        folderPath: string[],
        rootFolderId: string = '1',
    ): Promise<BookmarkMoveResult> {
        const normalizedPath = this.normalizePath(folderPath);
        const existingBookmark = await this.getBookmark(bookmarkId);
        if (!existingBookmark.url) {
            throw new Error('Only URL bookmarks can be re-classified.');
        }

        const previousFolderPath = await this.getBookmarkPath(bookmarkId);
        const folderId = await this.ensureFolderPath(rootFolderId, normalizedPath);
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

    private async ensureFolderPath(rootFolderId: string, path: string[]): Promise<string> {
        let currentId = rootFolderId;
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
        const target = this.normalizeFolderTitle(name);
        const folders = children.filter((child) => !child.url);

        // Prefer exact match first.
        const exact = folders.find((child) => child.title === name);
        if (exact) {
            return exact;
        }

        // Then match by normalized title (ignoring leading emoji differences).
        return folders.find((child) => this.normalizeFolderTitle(child.title || '') === target) || null;
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
            .map((segment) => this.sanitizeFolderSegment(segment))
            .filter(Boolean)
            .slice(0, 3);
        if (!normalizedPath.length) {
            throw new Error('A target folder path is required.');
        }
        return normalizedPath;
    }

    private sanitizeFolderSegment(value: string): string {
        // Enforce "no emoji" in folder names, even if an upstream component returns them.
        // Strip emoji/pictographic characters anywhere in the string, then clean up separators.
        return value
            .trim()
            .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji}\u200d\uFE0F]+/gu, '')
            .replace(/[\s\-–—_:]+/g, ' ')
            .trim();
    }

    private normalizeFolderTitle(title: string): string {
        // Normalize to avoid duplicate folders caused by emojis and decoration differences.
        return title
            .trim()
            .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji}\u200d\uFE0F]+/gu, '')
            .replace(/[\s\-–—_:]+/g, ' ')
            .trim()
            .toLowerCase();
    }
}