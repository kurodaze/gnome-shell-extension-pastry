import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import {type Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AutoClear} from './autoClear.js';
import {type ClipContent, ClipboardMonitor} from './clipboard.js';
import * as Dialogs from './dialogs.js';
import {type EntryAction, EntryItem, type ItemContext, focusOnMotion} from './entryItem.js';
import {Icons} from './icons.js';
import * as Keys from './keys.js';
import {Paster} from './paste.js';
import {type Entry, Store, isCancelled} from './store.js';
import {buildMatcher, truncate} from './util.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');

const BOOT_ID_FILE = '/proc/sys/kernel/random/boot_id';
// Rows shown before the list scrolls, fewer only on screens too small for them
const VISIBLE_ROWS = 12;
const MAX_LIST_HEIGHT_RATIO = 0.6;
// Long entry text lengths widen the menu up to this share of the screen
const MAX_MENU_WIDTH_RATIO = 0.7;
const SCROLLBAR_HIDE_DELAY_MS = 800;
const SCROLLBAR_FADE_MS = 200;
const OSD_PREVIEW_LENGTH = 40;
// The typings require every parameter, the shell fills in defaults
const NO_HOVER = {hover: false} as PopupMenu.PopupSwitchMenuItem.ConstructorProps;
// Bigger copies (huge logs and the like) would slow down saving
const MAX_TEXT_LENGTH = 1024 * 1024;
// Keeps memory use and save times bounded however big the copies are
const MAX_HISTORY_TEXT = 16 * MAX_TEXT_LENGTH;

interface SelectOptions {
    move?: boolean;
    paste?: boolean;
}

export class PastryIndicator extends PanelMenu.Button {
    static {
        GObject.registerClass({GTypeName: 'PastryIndicator'}, this);
    }

    private readonly _ext: Extension;
    private readonly _settings: Gio.Settings;
    private readonly _icons: Icons;
    private readonly _store: Store;
    private readonly _clipboard: ClipboardMonitor;
    private readonly _paster: Paster;
    private readonly _items = new Map<number, EntryItem>();
    private _itemContext!: ItemContext;
    private _autoClear: AutoClear | null = null;
    private _dialog: Dialogs.PastryDialog | null = null;

    private _currentId: number | null = null;
    private _readSerial = 0;
    private _selectSerial = 0;
    private _loaded = false;
    private _destroyed = false;
    private _focusIdleId = 0;
    private _scrollbarTimeoutId = 0;
    private _menuMaxWidth = 0;
    private _menuLockedWidth = 0;
    private _restoreFocusId: number | null = null;

    private _panelIcon!: St.Icon;
    private _panelLabel!: St.Label;
    private _searchEntry!: St.Entry;
    private _scrollView!: St.ScrollView;
    private _scrollbar!: St.ScrollBar;
    private _listBox!: St.BoxLayout;
    private _pinnedSection!: PopupMenu.PopupMenuSection;
    private _historySection!: PopupMenu.PopupMenuSection;
    private _listSeparator!: PopupMenu.PopupSeparatorMenuItem;
    private _emptyLabel!: St.Label;
    private _privateItem!: PopupMenu.PopupSwitchMenuItem;

    constructor(ext: Extension, settings: Gio.Settings) {
        super(0.5, _('Pastry'), false);

        this._ext = ext;
        this._settings = settings;
        this._icons = new Icons(ext.dir);
        this._store = new Store();
        this._paster = new Paster();
        this._clipboard = new ClipboardMonitor(own => this._onClipboardChanged(own));

        this._buildPanel();
        this._buildMenu();
        this._updateItemContext();
        this._connectSettings();
        this._updatePanel();

        // Not _onDestroy(), that would replace PanelMenu.Button's, which destroys the menu
        this.connect('destroy', () => this._cleanUp());
        this._load().catch(e => {
            if (!isCancelled(e))
                console.error('Pastry: could not load history:', e);
        });
    }

    private get _menu(): PopupMenu.PopupMenu {
        return this.menu as PopupMenu.PopupMenu;
    }

    toggleMenu() {
        this.menu.toggle();
    }

    togglePrivateMode() {
        const enabled = !this._settings.get_boolean(Keys.PRIVATE_MODE);
        this._settings.set_boolean(Keys.PRIVATE_MODE, enabled);
        if (!this._menu.isOpen) {
            Main.osdWindowManager.showAll(
                this._icons.get('private'),
                enabled ? _('Private mode on') : _('Private mode off'), null, null);
        }
    }

    /** Selects the next (1) or previous (-1) entry in menu order. */
    cycle(direction: 1 | -1) {
        const entries = this._displayOrder();
        if (!entries.length)
            return;

        const index = entries.findIndex(e => e.id === this._currentId);
        const next = index < 0
            ? entries[direction > 0 ? 0 : entries.length - 1]
            : entries[(index + direction + entries.length) % entries.length];
        this._select(next, {move: false});

        if (this._settings.get_boolean(Keys.NOTIFY_ON_CYCLE) && !this._menu.isOpen) {
            // Like the panel, never show clipboard text in private mode
            let label: string | null = null;
            if (next.kind === 'image')
                label = _('Image');
            else if (!this._settings.get_boolean(Keys.PRIVATE_MODE))
                label = truncate(next.text, OSD_PREVIEW_LENGTH);
            Main.osdWindowManager.showAll(this._icons.get('clipboard'), label, null, null);
        }
    }

    clearHistory({confirm = true} = {}) {
        if (!this._loaded)
            return;

        if (confirm && this._settings.get_boolean(Keys.CONFIRM_CLEAR)) {
            this._openDialog(null, () => Dialogs.openConfirmDialog(
                _('Clear history?'),
                _('All entries except pinned ones will be removed.'),
                _('Clear'),
                () => this._clear()));
            return;
        }
        this._clear();
    }

    private _buildPanel() {
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._panelIcon = new St.Icon({style_class: 'system-status-icon'});
        this._panelLabel = new St.Label({
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._panelIcon);
        box.add_child(this._panelLabel);
        this.add_child(box);
    }

    private _buildMenu() {
        const menu = this._menu;
        menu.box.add_style_class_name('pastry-menu-box');

        this._searchEntry = new St.Entry({
            style_class: 'pastry-search-entry',
            hint_text: _('Type here to search...'),
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({
                gicon: this._icons.get('search'),
                style_class: 'pastry-search-icon',
            }),
        });
        const searchBox = new St.BoxLayout({style_class: 'pastry-search-box', x_expand: true});
        searchBox.add_child(this._searchEntry);
        menu.box.add_child(searchBox);

        const searchText = this._searchEntry.clutter_text;
        searchText.connect('text-changed', () => this._applyFilter());
        searchText.connect('activate', () => {
            const [first] = this._visibleItems();
            if (first) {
                menu.close();
                this._runAction(first, 'select');
            }
        });

        // Entries: both sections live in one scroll view, but they still
        // have to be added through a menu section to take part in focus
        // tracking and close the menu when activated
        const listSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(listSection);

        this._listBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        // The scrollbar only shows up while scrolling, the fade on the
        // cut-off edge tells there is more
        this._scrollView = new St.ScrollView({
            style_class: 'pastry-list',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            overlay_scrollbars: true,
            x_expand: true,
            child: this._listBox,
        });
        const adjustment = this._scrollView.vadjustment;
        // St has no accessor for its scrollbars
        this._scrollbar = this._scrollView.get_children().find((child): child is St.ScrollBar =>
            child instanceof St.ScrollBar && child.adjustment === adjustment)!;
        adjustment.connect('notify::value', () => {
            // Ignore the list being laid out again, only actual scrolling counts
            if (Clutter.get_current_event() || adjustment.get_transition('value'))
                this._flashScrollbar();
        });

        this._pinnedSection = new PopupMenu.PopupMenuSection();
        this._historySection = new PopupMenu.PopupMenuSection();
        for (const section of [this._pinnedSection, this._historySection]) {
            listSection.addMenuItem(section);
            listSection.box.remove_child(section.actor);
        }
        listSection.box.add_child(this._scrollView);

        this._listSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this._emptyLabel = new St.Label({
            style_class: 'pastry-empty-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        for (const actor of [this._pinnedSection.actor, this._listSeparator,
            this._historySection.actor, this._emptyLabel])
            this._listBox.add_child(actor);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Footer items move up as the list shrinks, see focusOnMotion()
        this._privateItem = new PopupMenu.PopupSwitchMenuItem(
            _('Private mode'), this._settings.get_boolean(Keys.PRIVATE_MODE), NO_HOVER);
        this._privateItem.insert_child_at_index(new St.Icon({
            gicon: this._icons.get('private'),
            style_class: 'popup-menu-icon',
        }), 1);
        this._privateItem.connect('toggled', (_item, state: boolean) =>
            this._settings.set_boolean(Keys.PRIVATE_MODE, state));
        menu.addMenuItem(this._privateItem);

        const settingsItem = new PopupMenu.PopupImageMenuItem(
            _('Settings'), this._icons.get('settings'), NO_HOVER);
        settingsItem.connect('activate', () => this._ext.openPreferences());
        menu.addMenuItem(settingsItem);

        const clearItem = new PopupMenu.PopupImageMenuItem(
            _('Clear history'), this._icons.get('clear'), NO_HOVER);
        clearItem.connect('activate', () => this.clearHistory());
        menu.addMenuItem(clearItem);

        for (const item of [this._privateItem, settingsItem, clearItem])
            focusOnMotion(item);

        menu.connect('open-state-changed', (_menu, open: boolean) => {
            if (open)
                this._onMenuOpened();
            else
                this._hideScrollbar();
        });
    }

    private _updateItemContext() {
        this._itemContext = {
            icons: this._icons,
            previewLength: this._settings.get_int(Keys.PREVIEW_LENGTH),
            resourceScale: () => Math.max(1, this.get_resource_scale()),
            imageFile: entry => this._store.imageFile(entry),
            onAction: (item, action) => this._runAction(item, action),
            onTypeAhead: text => this._typeAhead(text),
            onFocused: item => {
                // Only keyboard focus scrolls rows into view. The pointer
                // focuses rows too, and they must not move under it.
                const event = Clutter.get_current_event();
                if (!event || event.type() === Clutter.EventType.KEY_PRESS)
                    ensureActorVisibleInScrollView(this._scrollView, item);
            },
        };
    }

    private _connectSettings() {
        const on = (keys: string[], callback: () => void) => {
            for (const key of keys)
                this._settings.connectObject(`changed::${key}`, callback, this);
        };

        on([Keys.PRIVATE_MODE], () => {
            this._privateItem.setToggleState(this._settings.get_boolean(Keys.PRIVATE_MODE));
            this._updatePanel();
        });
        on([Keys.DISPLAY_MODE, Keys.TOPBAR_PREVIEW_LENGTH], () => this._updatePanel());
        on([Keys.PREVIEW_LENGTH], () => {
            this._updateItemContext();
            for (const item of [...this._items.values()])
                item.destroy();
            this._sync();
        });
        on([Keys.HISTORY_SIZE], () => {
            if (!this._loaded)
                return;
            this._trim();
            this._sync();
        });
    }

    private async _load() {
        await this._store.load();
        const bootId = await readBootId();
        if (this._destroyed)
            return;

        this._clearOnBoot(bootId);
        this._loaded = true;
        this._autoClear = new AutoClear(this._settings, () => this.clearHistory({confirm: false}));
        this._sync();

        // Pick up whatever is on the clipboard right now
        this._onClipboardChanged(false);
    }

    private _clearOnBoot(bootId: string | null) {
        if (!bootId || bootId === this._settings.get_string(Keys.LAST_BOOT_ID))
            return;

        this._settings.set_string(Keys.LAST_BOOT_ID, bootId);
        if (this._settings.get_boolean(Keys.CLEAR_ON_BOOT))
            this._store.removeWhere(e => !e.pinned);
    }

    private _cleanUp() {
        this._destroyed = true;
        if (this._focusIdleId)
            GLib.source_remove(this._focusIdleId);
        this._focusIdleId = 0;
        if (this._scrollbarTimeoutId)
            GLib.source_remove(this._scrollbarTimeoutId);
        this._scrollbarTimeoutId = 0;

        this._dialog?.destroy();
        this._dialog = null;
        this._autoClear?.destroy();
        this._autoClear = null;
        this._clipboard.destroy();
        this._paster.destroy();
        this._store.destroy();
    }

    private _onClipboardChanged(own: boolean) {
        // Our own changes also outdate reads still in flight
        const serial = ++this._readSerial;
        if (own || !this._loaded)
            return;

        if (this._settings.get_boolean(Keys.PRIVATE_MODE) || this._isExcludedAppFocused()) {
            this._setCurrent(null);
            return;
        }

        this._clipboard.read({
            images: this._settings.get_boolean(Keys.TRACK_IMAGES),
            maxImageBytes: this._settings.get_int(Keys.MAX_IMAGE_SIZE) * 1024 * 1024,
            maxTextLength: MAX_TEXT_LENGTH,
        })
            .then(content => this._addContent(content, serial))
            .catch(e => {
                if (!isCancelled(e))
                    console.error('Pastry: could not read the clipboard:', e);
            });
    }

    private async _addContent(content: ClipContent | null, serial: number) {
        const stale = () => serial !== this._readSerial || this._destroyed;
        if (stale())
            return;
        if (!content) {
            this._setCurrent(null);
            return;
        }

        let entry: Entry | undefined;
        let added = false;
        if (content.kind === 'text') {
            const text = this._settings.get_boolean(Keys.STRIP_TEXT) ? content.text.trim() : content.text;
            if (!text.trim() || text.length > MAX_TEXT_LENGTH) {
                this._setCurrent(null);
                return;
            }
            entry = this._store.findText(text);
            if (!entry) {
                entry = this._store.add({kind: 'text', text, image: '', mime: '', pinned: false, tag: ''});
                added = true;
            }
        } else {
            const name = this._store.imageName(content.bytes, content.mime);
            entry = this._store.findImage(name);
            if (!entry) {
                await this._store.writeImage(name, content.bytes);
                if (stale())
                    return;
                entry = this._store.add({kind: 'image', text: '', image: name, mime: content.mime, pinned: false, tag: ''});
                added = true;
            }
        }

        // Copying something again makes it the most recent entry
        if (!added && entry.id !== this._currentId)
            this._store.moveToTop(entry);
        this._currentId = entry.id;
        this._trim();
        this._sync();

        if (added && this._settings.get_boolean(Keys.NOTIFY_ON_COPY)) {
            Main.notify(_('Copied to clipboard'),
                entry.kind === 'text' ? truncate(entry.text, this._itemContext.previewLength) : _('Image'));
        }
    }

    private _isExcludedAppFocused(): boolean {
        const excluded = this._settings.get_strv(Keys.EXCLUDED_APPS);
        if (!excluded.length)
            return false;
        const app = Shell.WindowTracker.get_default().focus_app;
        return app !== null && excluded.includes(app.get_id());
    }

    private async _select(entry: Entry, options: SelectOptions = {}) {
        const {move = this._settings.get_boolean(Keys.MOVE_ITEM_FIRST), paste = false} = options;
        const serial = ++this._selectSerial;
        try {
            if (entry.kind === 'text') {
                this._clipboard.setText(entry.text);
            } else {
                const bytes = await this._store.readImage(entry);
                // A later selection wins
                if (this._destroyed || serial !== this._selectSerial)
                    return;
                this._clipboard.setImage(bytes, entry.mime);
            }
        } catch (e) {
            if (!isCancelled(e))
                console.error('Pastry: could not set the clipboard:', e);
            return;
        }

        this._currentId = entry.id;
        if (move)
            this._store.moveToTop(entry);
        this._sync();

        if (paste)
            this._paster.paste();
    }

    private _setCurrent(id: number | null) {
        if (this._currentId === id)
            return;
        this._currentId = id;
        this._sync();
    }

    private _trim() {
        const removed = this._store.trim(this._settings.get_int(Keys.HISTORY_SIZE), MAX_HISTORY_TEXT);
        if (removed.some(e => e.id === this._currentId))
            this._currentId = null;
    }

    private _clear() {
        const removed = this._store.removeWhere(e => !e.pinned);
        // Don't leave the cleared content on the clipboard either
        if (removed.some(e => e.id === this._currentId)) {
            this._clipboard.clear();
            this._currentId = null;
        }
        this._sync();
    }

    private _runAction(item: EntryItem, action: EntryAction) {
        const {entry} = item;
        switch (action) {
        case 'select':
            this._select(entry, {paste: this._settings.get_boolean(Keys.PASTE_ON_SELECT)});
            break;
        case 'paste':
            this.menu.close();
            this._select(entry, {paste: true});
            break;
        case 'pin':
            entry.pinned = !entry.pinned;
            this._store.queueSave();
            this._sync();
            break;
        case 'delete':
            this._delete(item);
            break;
        case 'edit':
            if (entry.kind === 'text') {
                this._openDialog(entry, () => Dialogs.openEditDialog(entry.text,
                    text => this._applyEdit(entry, text)));
            }
            break;
        case 'tag':
            this._openDialog(entry, () => Dialogs.openTagDialog(entry.tag, tag => {
                entry.tag = tag;
                this._store.queueSave();
                this._sync();
            }));
            break;
        case 'preview':
            if (entry.kind === 'image')
                this._openDialog(entry, () => Dialogs.openPreviewDialog(this._store.imageFile(entry)));
            break;
        }
    }

    private _delete(item: EntryItem) {
        const {entry} = item;
        const hadFocus = item.has_key_focus();
        const visible = this._visibleItems();
        const index = visible.indexOf(item);
        const neighbour = visible[index + 1] ?? visible[index - 1];

        this._store.remove(entry);
        if (entry.id === this._currentId) {
            this._clipboard.clear();
            this._currentId = null;
        }
        this._sync();

        if (hadFocus)
            (neighbour ?? this._searchEntry).grab_key_focus();
    }

    private _applyEdit(entry: Entry, text: string) {
        if (!text.trim() || text === entry.text || !this._store.get(entry.id))
            return;

        // Merge with an existing entry that already has this text
        const duplicate = this._store.findText(text);
        if (duplicate) {
            entry.pinned ||= duplicate.pinned;
            entry.tag ||= duplicate.tag;
            if (duplicate.id === this._currentId)
                this._currentId = entry.id;
            this._store.remove(duplicate);
        }

        entry.text = text;
        this._store.queueSave();
        if (entry.id === this._currentId)
            this._clipboard.setText(text);
        this._sync();
    }

    /**
     * Opens a dialog in place of the menu. When `entry` is given, the
     * menu comes back afterwards with that entry focused.
     */
    private _openDialog(entry: Entry | null, open: () => Dialogs.PastryDialog) {
        this.menu.close();
        this._dialog?.destroy();

        const dialog = open();
        this._dialog = dialog;
        dialog.connect('closed', () => {
            if (this._dialog === dialog)
                this._dialog = null;
            if (entry && !this._destroyed) {
                this._restoreFocusId = this._store.get(entry.id) ? entry.id : null;
                this.menu.open();
            }
        });
    }

    private _onMenuOpened() {
        // Keep the search when coming back from a dialog
        if (this._restoreFocusId === null)
            this._searchEntry.text = '';
        this._syncItems();

        const workArea = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        let maxHeight = workArea.height * MAX_LIST_HEIGHT_RATIO;
        const items = [...this._items.values()];
        const row = items.find(item => item.entry.kind === 'text') ?? items[0];
        if (row) {
            // Icons in rows that were never shown have no size yet
            const ensureStyle = (actor: Clutter.Actor) => {
                if (actor instanceof St.Widget)
                    actor.ensure_style();
                actor.get_children().forEach(ensureStyle);
            };
            ensureStyle(row);
            ensureStyle(this._listSeparator);

            // Whole rows only, so the last one is never cut in half
            const rowHeight = row.get_preferred_height(-1)[1];
            const rows = Math.max(1, Math.min(VISIBLE_ROWS, Math.floor(maxHeight / rowHeight)));
            maxHeight = rows * rowHeight;
            if (this._listSeparator.visible)
                maxHeight += this._listSeparator.get_preferred_height(-1)[1];
        }
        this._scrollView.style = `max-height: ${Math.round(maxHeight / scale)}px;`;
        this._menuMaxWidth = Math.round(workArea.width * MAX_MENU_WIDTH_RATIO / scale);
        this._menuLockedWidth = 0;
        this._updateMenuWidth();

        // The menu grabs focus after this handler runs, so wait a bit
        if (this._focusIdleId)
            GLib.source_remove(this._focusIdleId);
        this._focusIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._focusIdleId = 0;
            const item = this._restoreFocusId !== null ? this._items.get(this._restoreFocusId) : undefined;
            this._restoreFocusId = null;
            if (item?.visible)
                item.grab_key_focus();
            else
                this._searchEntry.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    private _updateMenuWidth() {
        let style = `max-width: ${this._menuMaxWidth}px;`;
        if (this._menuLockedWidth)
            style += ` min-width: ${this._menuLockedWidth}px;`;
        this._menu.box.style = style;
    }

    /** Keeps the menu from shrinking while the search hides long entries. */
    private _lockMenuWidth(lock: boolean) {
        const {box} = this._menu;
        let width = 0;
        // Typing has just queued a relayout, so has_allocation() is false here
        if (lock && box.width > 0) {
            const node = box.get_theme_node();
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const content = box.width - node.get_horizontal_padding() -
                node.get_border_width(St.Side.LEFT) - node.get_border_width(St.Side.RIGHT);
            width = Math.ceil(content / scale);
        }
        if (width !== this._menuLockedWidth) {
            this._menuLockedWidth = width;
            this._updateMenuWidth();
        }
    }

    private _flashScrollbar() {
        const scrollbar = this._scrollbar;
        if (this._scrollView.vscrollbar_policy !== St.PolicyType.AUTOMATIC) {
            scrollbar.opacity = 0;
            this._scrollView.vscrollbar_policy = St.PolicyType.AUTOMATIC;
        }
        scrollbar.remove_all_transitions();
        scrollbar.ease({
            opacity: 255,
            duration: SCROLLBAR_FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        if (this._scrollbarTimeoutId)
            GLib.source_remove(this._scrollbarTimeoutId);
        this._scrollbarTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SCROLLBAR_HIDE_DELAY_MS, () => {
            this._scrollbarTimeoutId = 0;
            scrollbar.ease({
                opacity: 0,
                duration: SCROLLBAR_FADE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => (this._scrollView.vscrollbar_policy = St.PolicyType.EXTERNAL),
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    private _hideScrollbar() {
        if (this._scrollbarTimeoutId)
            GLib.source_remove(this._scrollbarTimeoutId);
        this._scrollbarTimeoutId = 0;
        this._scrollbar.remove_all_transitions();
        this._scrollbar.opacity = 0;
        this._scrollView.vscrollbar_policy = St.PolicyType.EXTERNAL;
    }

    private _typeAhead(text: string | null) {
        const clutterText = this._searchEntry.clutter_text;
        if (text === null)
            this._searchEntry.text = [...this._searchEntry.text].slice(0, -1).join('');
        else
            this._searchEntry.text += text;
        this._searchEntry.grab_key_focus();
        clutterText.set_selection(-1, -1);
    }

    /** Entries in the order the menu shows them. */
    private _displayOrder(): Entry[] {
        return [
            ...this._store.entries.filter(e => e.pinned),
            ...this._store.entries.filter(e => !e.pinned),
        ];
    }

    private _visibleItems(): EntryItem[] {
        return [this._pinnedSection, this._historySection]
            .flatMap(section => section.box.get_children())
            .filter((child): child is EntryItem => child instanceof EntryItem && child.visible);
    }

    /** Brings the panel and, while the menu is open, its items in line with the store. */
    private _sync() {
        this._updatePanel();
        // Rows are built when the menu opens, see _onMenuOpened()
        if (this._menu.isOpen)
            this._syncItems();
    }

    private _syncItems() {
        const focus = global.stage.get_key_focus();
        const focusedId = focus instanceof EntryItem ? focus.entry.id : null;

        const ids = new Set(this._store.entries.map(e => e.id));
        for (const [id, item] of this._items) {
            if (!ids.has(id))
                item.destroy();
        }

        this._syncSection(this._pinnedSection, this._store.entries.filter(e => e.pinned));
        this._syncSection(this._historySection, this._store.entries.filter(e => !e.pinned));
        for (const item of this._items.values())
            item.sync(item.entry.id === this._currentId);

        this._applyFilter();

        // Pinning recreates the item in the other section
        if (focusedId !== null && global.stage.get_key_focus() !== focus) {
            const item = this._items.get(focusedId);
            if (item?.visible)
                item.grab_key_focus();
        }
    }

    private _syncSection(section: PopupMenu.PopupMenuSection, entries: Entry[]) {
        entries.forEach((entry, index) => {
            let item = this._items.get(entry.id);
            if (item && item.section !== section) {
                item.destroy();
                item = undefined;
            }

            if (!item) {
                const newItem = new EntryItem(entry, section, this._itemContext);
                newItem.connect('destroy', () => {
                    if (this._items.get(entry.id) === newItem)
                        this._items.delete(entry.id);
                });
                this._items.set(entry.id, newItem);
                // Appending is much cheaper than inserting at a position
                section.addMenuItem(newItem, index < section.box.get_n_children() ? index : undefined);
            } else if (section.box.get_child_at_index(index) !== item) {
                section.box.set_child_at_index(item, index);
            }
        });
    }

    private _applyFilter() {
        const matcher = buildMatcher(this._searchEntry.text);
        if (!matcher || !this._menuLockedWidth)
            this._lockMenuWidth(matcher !== null && this._menu.isOpen);
        if (matcher && !matcher.valid)
            this._searchEntry.add_style_class_name('pastry-search-invalid');
        else
            this._searchEntry.remove_style_class_name('pastry-search-invalid');

        for (const item of this._items.values())
            item.visible = !matcher || item.matches(matcher);

        const hasVisible = (section: PopupMenu.PopupMenuSection) =>
            section.box.get_children().some(child => child.visible);
        const pinnedVisible = hasVisible(this._pinnedSection);
        const historyVisible = hasVisible(this._historySection);

        this._pinnedSection.actor.visible = pinnedVisible;
        this._historySection.actor.visible = historyVisible;
        this._listSeparator.visible = pinnedVisible && historyVisible;
        this._emptyLabel.visible = !pinnedVisible && !historyVisible;
        this._emptyLabel.text = this._store.entries.length ? _('No matches') : _('History is empty');
    }

    private _updatePanel() {
        const privateMode = this._settings.get_boolean(Keys.PRIVATE_MODE);
        const mode = this._settings.get_string(Keys.DISPLAY_MODE) as Keys.DisplayMode;
        const current = this._currentId !== null ? this._store.get(this._currentId) : undefined;

        // Never show clipboard text in the panel while in private mode
        let text = '';
        if (current && !privateMode) {
            text = current.kind === 'text'
                ? truncate(current.text, this._settings.get_int(Keys.TOPBAR_PREVIEW_LENGTH))
                : _('Image');
        }

        this._panelLabel.text = text;
        this._panelLabel.visible = mode !== 'icon' && text !== '';
        this._panelIcon.visible = mode !== 'text' || text === '';
        this._panelIcon.gicon = this._icons.get(privateMode ? 'private' : 'clipboard');
    }
}

async function readBootId(): Promise<string | null> {
    try {
        const [contents] = await Gio.File.new_for_path(BOOT_ID_FILE).load_contents_async(null);
        return new TextDecoder().decode(contents).trim();
    } catch {
        return null;
    }
}
