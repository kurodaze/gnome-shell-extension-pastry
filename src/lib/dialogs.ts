import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {loadImage} from './image.js';

export type PastryDialog = ModalDialog.ModalDialog;

function createDialog(styleClass?: string): PastryDialog {
    return new ModalDialog.ModalDialog({styleClass} as Partial<ModalDialog.ModalDialog.ConstructorProps>);
}

function isEnter(keyval: number): boolean {
    return keyval === Clutter.KEY_Return || keyval === Clutter.KEY_KP_Enter ||
        keyval === Clutter.KEY_ISO_Enter;
}

/** Multi-line text editor. Ctrl+Enter saves, Escape cancels. */
export function openEditDialog(text: string, onSave: (text: string) => void): PastryDialog {
    const dialog = createDialog();
    dialog.contentLayout.add_child(new Dialog.MessageDialogContent({title: _('Edit entry')}));

    const entry = new St.Entry({
        style_class: 'pastry-edit-entry',
        text,
        can_focus: true,
        x_expand: true,
    });
    const clutterText = entry.clutter_text;
    clutterText.set({
        single_line_mode: false,
        activatable: false,
        line_wrap: true,
        line_wrap_mode: Pango.WrapMode.WORD_CHAR,
        ellipsize: Pango.EllipsizeMode.NONE,
    });

    const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
    box.add_child(entry);
    const scrollView = new St.ScrollView({
        style_class: 'pastry-edit-scroll',
        hscrollbar_policy: St.PolicyType.NEVER,
        vscrollbar_policy: St.PolicyType.AUTOMATIC,
        child: box,
    });
    dialog.contentLayout.add_child(scrollView);

    // Keep the cursor in view while typing in long text
    clutterText.connect('cursor-changed', () => {
        const rect = clutterText.get_cursor_rect();
        const top = entry.y + clutterText.y + rect.origin.y;
        const bottom = top + rect.size.height;
        const adjustment = scrollView.vadjustment;
        if (top < adjustment.value)
            adjustment.value = top;
        else if (bottom > adjustment.value + adjustment.page_size)
            adjustment.value = bottom - adjustment.page_size;
    });

    const save = () => {
        dialog.close();
        onSave(entry.text);
    };

    const keys = new Clutter.KeyController();
    keys.connect('key-press', () => {
        const [, keyval] = keys.get_key();
        const [, pressed] = keys.get_state();
        if (isEnter(keyval) && (pressed & Clutter.ModifierType.CONTROL_MASK)) {
            save();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    });
    clutterText.add_action(keys);

    dialog.setButtons([
        {label: _('Cancel'), action: () => dialog.close(), key: Clutter.KEY_Escape},
        {label: _('Save'), action: save},
    ]);
    dialog.setInitialKeyFocus(entry);
    dialog.open();
    return dialog;
}

/** Single-line tag editor. An empty tag removes it. */
export function openTagDialog(tag: string, onSave: (tag: string) => void): PastryDialog {
    const dialog = createDialog();
    const content = new Dialog.MessageDialogContent({
        title: tag ? _('Edit tag') : _('Add tag'),
        description: _('Tags show next to the entry and are included in search.'),
    });
    dialog.contentLayout.add_child(content);

    const entry = new St.Entry({
        style_class: 'pastry-tag-entry',
        text: tag,
        hint_text: _('Tag name'),
        can_focus: true,
        x_expand: true,
    });
    content.add_child(entry);

    const save = (value: string) => {
        dialog.close();
        onSave(value.trim());
    };
    entry.clutter_text.connect('activate', () => save(entry.text));

    const buttons: Dialog.ButtonInfo[] = [
        {label: _('Cancel'), action: () => dialog.close(), key: Clutter.KEY_Escape},
    ];
    if (tag)
        buttons.push({label: _('Remove'), action: () => save('')});
    buttons.push({label: _('Save'), action: () => save(entry.text)});
    dialog.setButtons(buttons);

    dialog.setInitialKeyFocus(entry);
    entry.clutter_text.set_selection(0, -1);
    dialog.open();
    return dialog;
}

/** Shows an image scaled to fit most of the screen. */
export function openPreviewDialog(file: Gio.File): PastryDialog {
    const dialog = createDialog('pastry-preview-dialog');

    const monitor = Main.layoutManager.currentMonitor ?? Main.layoutManager.primaryMonitor;
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const maxWidth = Math.floor(monitor!.width / scale * 0.7);
    const maxHeight = Math.floor(monitor!.height / scale * 0.6);
    const texture = loadImage(file, maxWidth, maxHeight, Math.max(1, dialog.get_resource_scale()), false);

    dialog.contentLayout.add_child(new St.Bin({
        style_class: 'pastry-preview',
        x_align: Clutter.ActorAlign.CENTER,
        child: texture,
    }));

    // h toggles the preview from the menu, so let it close it too
    const keys = new Clutter.KeyController();
    keys.connect('key-press', () => {
        const [, keyval] = keys.get_key();
        if (keyval === Clutter.KEY_Escape || keyval === Clutter.KEY_h || isEnter(keyval)) {
            dialog.close();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    });
    dialog.add_action(keys);

    // Dialog buttons stretch to the dialog width, which wide images make huge
    const close = dialog.addButton({label: _('Close'), action: () => dialog.close()});
    close.x_expand = false;
    dialog.buttonLayout.x_align = Clutter.ActorAlign.CENTER;

    dialog.open();
    return dialog;
}

export function openConfirmDialog(
    title: string, description: string, confirmLabel: string, onConfirm: () => void
): PastryDialog {
    const dialog = createDialog();
    dialog.contentLayout.add_child(new Dialog.MessageDialogContent({title, description}));
    dialog.setButtons([
        {label: _('Cancel'), action: () => dialog.close(), key: Clutter.KEY_Escape},
        {
            label: confirmLabel,
            action: () => {
                dialog.close();
                onConfirm();
            },
            default: true,
        },
    ]);
    dialog.open();
    return dialog;
}
