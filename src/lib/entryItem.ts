import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import type {IconName, Icons} from './icons.js';
import {loadImage} from './image.js';
import type {Entry} from './store.js';
import {type Matcher, truncate} from './util.js';

export type EntryAction = 'select' | 'edit' | 'preview' | 'pin' | 'paste' | 'tag' | 'delete';

export interface ItemContext {
    icons: Icons;
    previewLength: number;
    resourceScale(): number;
    imageFile(entry: Entry): Gio.File;
    onAction(item: EntryItem, action: EntryAction): void;
    /** Typed text that should go to the search entry, null for backspace. */
    onTypeAhead(text: string | null): void;
    onFocused(item: EntryItem): void;
}

const TAG_LENGTH = 24;
const UNPINNED_OPACITY = 110;
// Fits inside the action buttons (see stylesheet.css) together with the
// thumbnail border, so image rows are exactly as tall as text rows
const THUMBNAIL_HEIGHT = 28;

// Alt and Super show up as MOD1 and MOD4
const IGNORED_MODIFIERS =
    Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.MOD4_MASK;

const KEY_ACTIONS = new Map<number, EntryAction>([
    [Clutter.KEY_Delete, 'delete'],
    [Clutter.KEY_KP_Delete, 'delete'],
    [Clutter.KEY_v, 'paste'],
    [Clutter.KEY_p, 'pin'],
    [Clutter.KEY_t, 'tag'],
    [Clutter.KEY_h, 'preview'],
    [Clutter.KEY_e, 'edit'],
]);

/**
 * Focuses an item created with `hover: false` on real pointer movement only.
 * Items sliding under a resting pointer while the search filters must not
 * steal focus, or the next letter typed would trigger an action.
 */
export function focusOnMotion(item: PopupMenu.PopupBaseMenuItem) {
    const motion = new Clutter.MotionController();
    motion.connect('motion', () => {
        if (!item.active)
            item.active = true;
    });
    item.add_action(motion);
}

/** A history entry in the menu: preview, tag and action buttons. */
export class EntryItem extends PopupMenu.PopupBaseMenuItem {
    static {
        GObject.registerClass({GTypeName: 'PastryEntryItem'}, this);
    }

    readonly entry: Entry;
    readonly section: PopupMenu.PopupMenuSection;

    private readonly _ctx: ItemContext;
    private readonly _dot: St.Icon;
    private readonly _label: St.Label | null = null;
    private readonly _tagLabel: St.Label;
    private readonly _pinButton: St.Button;

    constructor(entry: Entry, section: PopupMenu.PopupMenuSection, ctx: ItemContext) {
        // Hover still highlights the item, but does not grab focus by itself
        super({style_class: 'pastry-entry', hover: false});

        this.entry = entry;
        this.section = section;
        this._ctx = ctx;

        // A plain dot marks the current entry. The shell's own DOT ornament
        // is a radio button, so keep it hidden and reuse its spacing instead.
        this.add_style_class_name('popup-ornamented-menu-item');
        this._dot = new St.Icon({
            style_class: 'popup-menu-ornament',
            gicon: ctx.icons.get('dot'),
            opacity: 0,
        });
        this.add_child(this._dot);

        const content = new St.BoxLayout({
            style_class: 'pastry-entry-content',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(content);

        if (entry.kind === 'text') {
            this._label = new St.Label({y_align: Clutter.ActorAlign.CENTER});
            this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            content.add_child(this._label);
            this.label_actor = this._label;
        } else {
            content.add_child(this._createThumbnail());
            this.accessible_name = _('Image');
        }

        this._tagLabel = new St.Label({
            style_class: 'pastry-tag',
            y_align: Clutter.ActorAlign.CENTER,
        });
        content.add_child(this._tagLabel);

        const buttons = new St.BoxLayout({
            style_class: 'pastry-entry-buttons',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(buttons);

        if (entry.kind === 'text')
            this._addButton(buttons, 'edit', 'edit', _('Edit'));
        else
            this._addButton(buttons, 'image', 'preview', _('Preview'));
        this._pinButton = this._addButton(buttons, 'pin', 'pin', _('Pin'));
        this._addButton(buttons, 'tag', 'tag', _('Tag'));
        this._addButton(buttons, 'delete', 'delete', _('Delete'));

        const keys = new Clutter.KeyController();
        keys.connect('key-press', () => this._onKeyPress(keys));
        this.add_action(keys);

        focusOnMotion(this);

        this.connect('activate', () => ctx.onAction(this, 'select'));
        this.connect('key-focus-in', () => ctx.onFocused(this));
    }

    /** Refreshes the widgets from the entry. */
    sync(current: boolean) {
        const {entry} = this;
        if (this._label)
            this._label.text = truncate(entry.text, this._ctx.previewLength);

        this._tagLabel.text = truncate(entry.tag, TAG_LENGTH);
        this._tagLabel.visible = entry.tag !== '';

        // Opacity rather than a color so it works with light and dark styles
        this._pinButton.opacity = entry.pinned ? 255 : UNPINNED_OPACITY;
        this._pinButton.accessible_name = entry.pinned ? _('Unpin') : _('Pin');

        this._dot.opacity = current ? 255 : 0;
        if (current)
            this.add_accessible_state(Atk.StateType.CHECKED);
        else
            this.remove_accessible_state(Atk.StateType.CHECKED);
    }

    matches(matcher: Matcher): boolean {
        const {entry} = this;
        return (entry.kind === 'text' && matcher.test(entry.text)) ||
            (entry.tag !== '' && matcher.test(entry.tag));
    }

    private _createThumbnail(): St.Bin {
        // Wide images may grow up to four times the height
        const texture = loadImage(this._ctx.imageFile(this.entry),
            THUMBNAIL_HEIGHT * 4, THUMBNAIL_HEIGHT, this._ctx.resourceScale(), true);

        return new St.Bin({
            style_class: 'pastry-thumbnail',
            y_align: Clutter.ActorAlign.CENTER,
            child: texture,
        });
    }

    private _addButton(box: St.BoxLayout, icon: IconName, action: EntryAction, label: string): St.Button {
        const button = new St.Button({
            style_class: 'pastry-action',
            can_focus: false,
            accessible_name: label,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                gicon: this._ctx.icons.get(icon),
                style_class: 'pastry-action-icon',
            }),
        });
        button.connect('clicked', () => this._ctx.onAction(this, action));
        box.add_child(button);
        return button;
    }

    private _onKeyPress(keys: Clutter.KeyController): boolean {
        const [, keyval, , unicode] = keys.get_key();
        const [, pressed] = keys.get_state();
        if (pressed & IGNORED_MODIFIERS)
            return Clutter.EVENT_PROPAGATE;

        const action = KEY_ACTIONS.get(keyval);
        if (action) {
            this._ctx.onAction(this, action);
            return Clutter.EVENT_STOP;
        }

        if (keyval === Clutter.KEY_BackSpace) {
            this._ctx.onTypeAhead(null);
            return Clutter.EVENT_STOP;
        }

        // Anything else printable starts a search; space still activates
        if (unicode && unicode !== ' ' && /^\P{C}$/u.test(unicode)) {
            this._ctx.onTypeAhead(unicode);
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }
}
