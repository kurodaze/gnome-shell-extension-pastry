import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {IMAGE_MIME_TYPES} from './store.js';

Gio._promisify(Meta.Selection.prototype, 'transfer_async');

const CLIPBOARD = St.ClipboardType.CLIPBOARD;
// Set by KeePassXC and others on copied passwords
const SECRET_HINT = 'x-kde-passwordManagerHint';
// In the order St.Clipboard.get_text() picks them
const TEXT_MIME_TYPES = ['text/plain;charset=utf-8', 'UTF8_STRING', 'text/plain', 'STRING'];
// UTF-8 needs at most 3 bytes per UTF-16 code unit
const MAX_BYTES_PER_CHAR = 3;

export type ClipContent =
    | {kind: 'text'; text: string}
    | {kind: 'image'; bytes: GLib.Bytes; mime: string};

export interface ReadOptions {
    images: boolean;
    maxImageBytes: number;
    maxTextLength: number;
}

/** Watches the clipboard selection and reads or replaces its content. */
export class ClipboardMonitor {
    private readonly _clipboard = St.Clipboard.get_default();
    private readonly _selection = global.display.get_selection();
    private readonly _ownerChangedId: number;
    private _settingOwn = false;

    /** `onChange(own)` runs whenever the clipboard owner changes. */
    constructor(onChange: (own: boolean) => void) {
        this._ownerChangedId = this._selection.connect('owner-changed', (_selection, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                onChange(this._settingOwn);
        });
    }

    destroy() {
        this._selection.disconnect(this._ownerChangedId);
    }

    /** Reads the current content, preferring text over images. */
    async read({images, maxImageBytes, maxTextLength}: ReadOptions): Promise<ClipContent | null> {
        const mimeTypes = this._clipboard.get_mimetypes(CLIPBOARD);
        if (mimeTypes.includes(SECRET_HINT))
            return null;

        const textMime = TEXT_MIME_TYPES.find(type => mimeTypes.includes(type));
        if (textMime) {
            const bytes = await this._getContent(textMime, maxTextLength * MAX_BYTES_PER_CHAR);
            // Too long for sure, the exact length is checked once decoded
            if (!bytes)
                return null;
            const text = decodeText(bytes);
            if (text)
                return {kind: 'text', text};
        }

        const mime = IMAGE_MIME_TYPES.find(type => mimeTypes.includes(type));
        if (!images || !mime)
            return null;

        const bytes = await this._getContent(mime, maxImageBytes);
        return bytes?.get_size() ? {kind: 'image', bytes, mime} : null;
    }

    setText(text: string) {
        this._setOwn(() => this._clipboard.set_text(CLIPBOARD, text));
    }

    setImage(bytes: GLib.Bytes, mime: string) {
        this._setOwn(() => this._clipboard.set_content(CLIPBOARD, mime, bytes));
    }

    clear() {
        this._setOwn(() => this._clipboard.set_text(CLIPBOARD, ''));
    }

    // The owner-changed signal fires synchronously while setting
    private _setOwn(set: () => void) {
        this._settingOwn = true;
        try {
            set();
        } finally {
            this._settingOwn = false;
        }
    }

    // St.Clipboard reads everything, so huge copies would be loaded in full
    // before the size check. Read at most one byte over the limit instead,
    // null means it was over.
    private async _getContent(mime: string, maxBytes: number): Promise<GLib.Bytes | null> {
        const stream = Gio.MemoryOutputStream.new_resizable();
        await this._selection.transfer_async(Meta.SelectionType.SELECTION_CLIPBOARD,
            mime, maxBytes + 1, stream, null);
        stream.close(null);
        return stream.get_data_size() <= maxBytes ? stream.steal_as_bytes() : null;
    }
}

function decodeText(bytes: GLib.Bytes): string {
    const data = bytes.toArray();
    // Like St.Clipboard, which hands out C strings, stop at the first NUL
    const end = data.indexOf(0);
    return new TextDecoder().decode(end < 0 ? data : data.subarray(0, end));
}
