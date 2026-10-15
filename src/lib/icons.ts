import Gio from 'gi://Gio';

export type IconName =
    | 'clipboard' | 'search' | 'edit' | 'image' | 'pin'
    | 'tag' | 'delete' | 'private' | 'settings' | 'clear' | 'dot';

/** Symbolic icons bundled in the extension's icons/ folder. */
export class Icons {
    private readonly _dir: Gio.File;
    private readonly _cache = new Map<IconName, Gio.Icon>();

    constructor(extensionDir: Gio.File) {
        this._dir = extensionDir.get_child('icons');
    }

    get(name: IconName): Gio.Icon {
        let icon = this._cache.get(name);
        if (!icon) {
            icon = new Gio.FileIcon({file: this._dir.get_child(`pastry-${name}-symbolic.svg`)});
            this._cache.set(name, icon);
        }
        return icon;
    }
}
