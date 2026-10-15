import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'load_bytes_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');

export type EntryKind = 'text' | 'image';

export interface Entry {
    /** Runtime identifier, not persisted. */
    id: number;
    kind: EntryKind;
    /** Text content, empty for images. */
    text: string;
    /** File name inside the images directory, empty for text. */
    image: string;
    mime: string;
    pinned: boolean;
    tag: string;
}

export type NewEntry = Omit<Entry, 'id'>;

/** Supported image types, in order of preference. */
const IMAGE_EXTENSIONS: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
};
export const IMAGE_MIME_TYPES = Object.keys(IMAGE_EXTENSIONS);
const IMAGE_NAME = /^[0-9a-f]{64}\.[a-z]+$/;

const FILE_FLAGS = Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE;
const SAVE_DELAY_MS = 500;
const FORMAT_VERSION = 1;

/**
 * Clipboard history, kept newest first and saved to
 * $XDG_DATA_HOME/pastry. Images are stored as separate files named
 * after their checksum.
 */
export class Store {
    entries: Entry[] = [];
    readonly imageDir: Gio.File;

    private readonly _historyFile: Gio.File;
    private readonly _cancellable = new Gio.Cancellable();
    private _nextId = 1;
    private _saveTimeoutId = 0;
    private _saving = false;
    private _dirty = false;

    constructor() {
        const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'pastry']);
        const imageDir = GLib.build_filenamev([dir, 'images']);
        GLib.mkdir_with_parents(imageDir, 0o700);

        this._historyFile = Gio.File.new_for_path(GLib.build_filenamev([dir, 'history.json']));
        this.imageDir = Gio.File.new_for_path(imageDir);
    }

    async load(): Promise<void> {
        let data: unknown = null;
        let readable = true;
        try {
            const [contents] = await this._historyFile.load_contents_async(this._cancellable);
            data = JSON.parse(new TextDecoder().decode(contents));
            const version = (data as {version?: unknown} | null)?.version;
            if (version !== FORMAT_VERSION)
                throw new Error(`unknown format version ${version}`);
        } catch (e) {
            if (isCancelled(e))
                throw e;
            data = null;
            if (!isNotFound(e)) {
                readable = false;
                console.error(`Pastry: could not read history, ${this._backUpHistory()}:`, e);
            }
        }

        this.entries = parseEntries(data)
            .filter(e => e.kind === 'text' || this.imageFile(e).query_exists(null))
            .map(e => ({...e, id: this._nextId++}));

        // The images may still belong to the backed up history
        if (readable)
            await this._removeOrphanImages();
    }

    destroy() {
        this._cancellable.cancel();
        if (this._saveTimeoutId) {
            GLib.source_remove(this._saveTimeoutId);
            this._saveTimeoutId = 0;
            this._dirty = true;
        }
        if (this._dirty || this._saving) {
            try {
                this._historyFile.replace_contents(this._serialize(), null, false, FILE_FLAGS, null);
            } catch (e) {
                console.error('Pastry: could not save history:', e);
            }
        }
        // A save in flight lands after the write above, so save again once it is done.
        // Cancelling it instead can leave an empty file behind.
        this._dirty = this._saving;
    }

    get(id: number): Entry | undefined {
        return this.entries.find(e => e.id === id);
    }

    findText(text: string): Entry | undefined {
        return this.entries.find(e => e.kind === 'text' && e.text === text);
    }

    findImage(name: string): Entry | undefined {
        return this.entries.find(e => e.kind === 'image' && e.image === name);
    }

    imageFile(entry: Pick<Entry, 'image'>): Gio.File {
        return this.imageDir.get_child(entry.image);
    }

    add(fields: NewEntry): Entry {
        const entry = {...fields, id: this._nextId++};
        this.entries.unshift(entry);
        this.queueSave();
        return entry;
    }

    moveToTop(entry: Entry) {
        const index = this.entries.indexOf(entry);
        if (index > 0) {
            this.entries.splice(index, 1);
            this.entries.unshift(entry);
            this.queueSave();
        }
    }

    remove(entry: Entry) {
        this.removeWhere(e => e === entry);
    }

    /** Removes matching entries and deletes images nobody uses anymore. */
    removeWhere(predicate: (entry: Entry) => boolean): Entry[] {
        const removed = this.entries.filter(predicate);
        if (!removed.length)
            return removed;

        this.entries = this.entries.filter(e => !predicate(e));
        for (const entry of removed) {
            if (entry.kind === 'image' && !this.findImage(entry.image))
                deleteFile(this.imageFile(entry));
        }
        this.queueSave();
        return removed;
    }

    /** Removes the oldest unpinned entries beyond `limit` entries or `maxChars` of text. */
    trim(limit: number, maxChars: number): Entry[] {
        let chars = 0;
        const excess = new Set(this.entries.filter(e => !e.pinned).filter((e, index) => {
            chars += e.text.length;
            return index >= limit || chars > maxChars;
        }));
        return this.removeWhere(e => excess.has(e));
    }

    /** File name an image would be stored under, derived from its content. */
    imageName(bytes: GLib.Bytes, mime: string): string {
        const hash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
        return `${hash}.${IMAGE_EXTENSIONS[mime]}`;
    }

    async writeImage(name: string, bytes: GLib.Bytes): Promise<void> {
        const file = this.imageDir.get_child(name);
        if (!file.query_exists(null))
            await file.replace_contents_bytes_async(bytes, null, false, FILE_FLAGS, this._cancellable);
    }

    async readImage(entry: Entry): Promise<GLib.Bytes> {
        const [bytes] = await this.imageFile(entry).load_bytes_async(this._cancellable);
        return bytes;
    }

    queueSave() {
        if (this._saveTimeoutId)
            return;
        this._saveTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
            this._saveTimeoutId = 0;
            this._save();
            return GLib.SOURCE_REMOVE;
        });
    }

    private _save() {
        // Never run two writes at once, the older one could land last
        if (this._saving) {
            this._dirty = true;
            return;
        }
        this._saving = true;
        this._dirty = false;

        this._historyFile.replace_contents_bytes_async(
            new GLib.Bytes(this._serialize()), null, false, FILE_FLAGS, null)
            .catch(e => console.error('Pastry: could not save history:', e))
            .finally(() => {
                this._saving = false;
                if (this._dirty)
                    this._save();
            });
    }

    private _serialize(): Uint8Array {
        const entries = this.entries.map(({kind, text, image, mime, pinned, tag}) =>
            ({kind, text, image, mime, pinned, tag}));
        const json = JSON.stringify({version: FORMAT_VERSION, entries});
        return new TextEncoder().encode(json);
    }

    /** Moves an unreadable history aside, so the next save does not overwrite it. */
    private _backUpHistory(): string {
        const backup = Gio.File.new_for_path(`${this._historyFile.get_path()}.bak`);
        try {
            this._historyFile.move(backup, Gio.FileCopyFlags.OVERWRITE, null, null);
            return `kept it as ${backup.get_path()}`;
        } catch (e) {
            return `could not back it up either (${e})`;
        }
    }

    private async _removeOrphanImages() {
        const used = new Set(this.entries.map(e => e.image));
        try {
            const children = await this.imageDir.enumerate_children_async('standard::name',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, this._cancellable);
            for await (const info of children) {
                if (!used.has(info.get_name()))
                    deleteFile(this.imageDir.get_child(info.get_name()));
            }
        } catch (e) {
            if (!isCancelled(e))
                console.error('Pastry: could not clean up images:', e);
        }
    }
}

function parseEntries(data: unknown): NewEntry[] {
    const list = (data as {entries?: unknown} | null)?.entries;
    if (!Array.isArray(list))
        return [];

    return list.filter(isValidEntry).map(({kind, text, image, mime, pinned, tag}) =>
        ({kind, text, image, mime, pinned, tag}));
}

/** Accepts entries exactly as _serialize() writes them. */
function isValidEntry(raw: unknown): raw is NewEntry {
    if (!raw || typeof raw !== 'object')
        return false;

    const {kind, text, image, mime, pinned, tag} = raw as Record<string, unknown>;
    if (typeof text !== 'string' || typeof image !== 'string' || typeof mime !== 'string' ||
        typeof pinned !== 'boolean' || typeof tag !== 'string')
        return false;
    if (kind === 'text')
        return text !== '';
    // Only names imageName() creates, never paths, and only supported types
    return kind === 'image' && IMAGE_NAME.test(image) && IMAGE_MIME_TYPES.includes(mime);
}

export function isCancelled(e: unknown): boolean {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function isNotFound(e: unknown): boolean {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND);
}

function deleteFile(file: Gio.File) {
    file.delete_async(GLib.PRIORITY_DEFAULT, null).catch(e => {
        if (!isNotFound(e))
            console.error(`Pastry: could not delete ${file.get_path()}:`, e);
    });
}
