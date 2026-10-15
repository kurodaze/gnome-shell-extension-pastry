// Automation script for a throwaway headless GNOME Shell.
// Copies an image the way the screenshot tool does and checks Pastry.
import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import System from 'system';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

export const METRICS = {};

const UUID = 'pastry@kurodaze.net';
const CLIPBOARD = St.ClipboardType.CLIPBOARD;

function png(width, height) {
    const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, width, height);
    pixbuf.fill(0x3366ffff);
    return pixbuf.save_to_bufferv('png', [], [])[1];
}

const PNG = png(40, 40);

// Random pixels barely compress, so this ends up over 1 MB
function noisyPng(width, height) {
    const data = new Uint8Array(width * height * 3);
    for (let i = 0; i < data.length; i++)
        data[i] = Math.random() * 256;
    const pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes(data),
        GdkPixbuf.Colorspace.RGB, false, 8, width, height, width * 3);
    return pixbuf.save_to_bufferv('png', [], [])[1];
}

function say(...args) {
    console.log('PASTRY TEST:', ...args);
}

function check(condition, message) {
    say(condition ? 'ok  ' : 'FAIL', message);
    if (!condition)
        throw new Error(message);
}

function images() {
    const dir = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), 'pastry', 'images']));
    const names = [];
    const e = dir.enumerate_children('standard::name', 0, null);
    for (let info = e.next_file(null); info; info = e.next_file(null))
        names.push(info.get_name());
    return names;
}

function clipboardMimetypes() {
    return St.Clipboard.get_default().get_mimetypes(CLIPBOARD);
}

function clipboardText() {
    return new Promise(resolve => St.Clipboard.get_default().get_text(CLIPBOARD, (_c, text) => resolve(text)));
}

async function waitForState(state) {
    const started = Date.now();
    while (Main.extensionManager.lookup(UUID)?.state !== state && Date.now() - started < 30000)
        await Scripting.sleep(200);
    return Main.extensionManager.lookup(UUID)?.state === state;
}

export async function run() {
    // No test windows here, and the helper quits by itself after 30s idle,
    // which makes the final exit call fail on longer runs
    await Scripting.disableHelperAutoExit();

    const themeContext = St.ThemeContext.get_for_stage(global.stage);
    const scale = Number(GLib.getenv('PASTRY_TEST_SCALE') ?? 1);
    if (scale !== 1)
        themeContext.scale_factor = scale;
    say(`screen ${global.screen_width}x${global.screen_height}, scale ${themeContext.scale_factor}`);

    // A cold start on a busy machine can take a while to load extensions
    const started = Date.now();
    while (Main.extensionManager.lookup(UUID)?.state !== ExtensionState.ACTIVE && Date.now() - started < 30000)
        await Scripting.sleep(200);
    const ext = Main.extensionManager.lookup(UUID);
    check(ext?.state === ExtensionState.ACTIVE,
        `extension active after ${((Date.now() - started) / 1000).toFixed(1)}s (state ${ext?.state} ${ext?.error ?? ''})`);
    await Scripting.sleep(1000);

    const indicator = Main.panel.statusArea[UUID];
    check(Boolean(indicator), 'indicator in panel');
    check(indicator._settings.get_string('last-boot-id') !== '', 'boot ID read for clear at boot');

    // Same call the screenshot tool makes, with bytes nobody else holds
    St.Clipboard.get_default().set_content(CLIPBOARD, 'image/png', new GLib.Bytes(PNG));
    for (let i = 0; i < 5; i++) {
        System.gc();
        await Scripting.sleep(300);
    }
    check(images().length === 1, `image stored on disk (${images().length} files)`);
    check(indicator._store.entries.some(e => e.kind === 'image'), 'image entry in history');

    St.Clipboard.get_default().set_text(CLIPBOARD, 'pastry text check');
    await Scripting.sleep(800);
    check(indicator._store.entries.some(e => e.kind === 'text' && e.text === 'pastry text check'),
        'text entry in history');
    check(indicator._items.size === 0, `rows wait for the menu to open (${indicator._items.size} built)`);

    // Texts over the length limit are skipped, the longest without reading them in full
    for (const length of [1.5 * 1024 * 1024, 4 * 1024 * 1024]) {
        // Only a finished read clears the current entry, a failed one leaves it
        St.Clipboard.get_default().set_text(CLIPBOARD, 'pastry text check');
        await Scripting.sleep(300);
        St.Clipboard.get_default().set_text(CLIPBOARD, 'x'.repeat(length));
        await Scripting.sleep(800);
        check(indicator._currentId === null && !indicator._store.entries.some(e => e.text.length > 1024 * 1024),
            `${(length / 1024 / 1024).toFixed(1)}M character text skipped`);
    }
    const unicode = 'pastry ünïcode ✓ 😀';
    St.Clipboard.get_default().set_text(CLIPBOARD, unicode);
    await Scripting.sleep(500);
    check(indicator._store.entries[0]?.text === unicode, 'unicode text kept as copied');

    // Images over the size limit are skipped, without reading them in full
    const bigPng = noisyPng(800, 800);
    indicator._settings.set_int('max-image-size', 1);
    St.Clipboard.get_default().set_content(CLIPBOARD, 'image/png', new GLib.Bytes(bigPng));
    await Scripting.sleep(800);
    check(images().length === 1, `${(bigPng.length / 1024 / 1024).toFixed(1)} MB image over the 1 MB limit skipped`);
    indicator._settings.reset('max-image-size');

    // Menu builds with a thumbnail row
    indicator.menu.open();
    await Scripting.sleep(800);
    const imageItem = [...indicator._items.values()].find(item => item.entry.kind === 'image');
    check(Boolean(imageItem), `image row in menu (${indicator._items.size} rows)`);
    indicator.menu.close();
    await Scripting.sleep(400);

    // Selecting the image puts it back on the clipboard
    indicator._runAction(imageItem, 'select');
    for (let i = 0; i < 3; i++) {
        System.gc();
        await Scripting.sleep(300);
    }
    check(clipboardMimetypes().includes('image/png'), `image back on clipboard (${clipboardMimetypes()})`);

    // Copy the same screenshot again: must not duplicate
    St.Clipboard.get_default().set_content(CLIPBOARD, 'image/png', new GLib.Bytes(PNG));
    await Scripting.sleep(800);
    check(indicator._store.entries.filter(e => e.kind === 'image').length === 1, 'no duplicate image');

    // Rows: edit/preview, pin, tag, delete
    const buttons = imageItem.get_last_child().get_n_children();
    check(buttons === 4, `row has 4 action buttons (${buttons})`);

    // Previewing a wide image keeps the close button compact
    const widePng = png(800, 60);
    St.Clipboard.get_default().set_content(CLIPBOARD, 'image/png', new GLib.Bytes(widePng));
    await Scripting.sleep(800);

    indicator.menu.open();
    await Scripting.sleep(400);
    const wideItem = [...indicator._items.values()].find(item =>
        item.entry.kind === 'image' && item !== imageItem);
    check(Boolean(wideItem), 'wide image row in menu');

    // Thumbnails keep the image's proportions
    const thumbnail = item => item.get_children()
        .find(child => child.style_class?.includes('pastry-entry-content'))
        .get_first_child().get_first_child();
    const ratio = actor => actor.width / actor.height;
    check(Math.abs(ratio(thumbnail(imageItem)) - 1) < 0.05,
        `square thumbnail stays square (${thumbnail(imageItem).width}x${thumbnail(imageItem).height})`);
    check(Math.abs(ratio(thumbnail(wideItem)) / (800 / 60) - 1) < 0.1,
        `wide thumbnail keeps its shape (${thumbnail(wideItem).width}x${thumbnail(wideItem).height})`);

    // Image rows are exactly as tall as text rows
    const textItem = [...indicator._items.values()].find(item => item.entry.kind === 'text');
    check(Math.abs(imageItem.height - textItem.height) < 1,
        `image rows as tall as text rows (${imageItem.height} and ${textItem.height}px)`);

    // The current entry gets a plain dot, not the shell's radio ornament
    const marked = [...indicator._items.values()].filter(item => item._dot.opacity === 255);
    check(marked.length === 1 && marked[0].entry.id === indicator._currentId &&
        !marked[0]._ornamentIcon.visible, 'current entry marked with a plain dot');

    indicator._runAction(wideItem, 'preview');
    await Scripting.sleep(1200);
    const dialog = indicator._dialog;
    check(Boolean(dialog), 'preview dialog open');
    const [closeButton] = dialog.buttonLayout.get_children();
    const dialogWidth = dialog.dialogLayout.get_first_child().width;
    check(closeButton.width < dialogWidth / 3,
        `close button compact (${Math.round(closeButton.width)}px of ${Math.round(dialogWidth)}px)`);
    const [boxX] = dialog.dialogLayout.get_first_child().get_transformed_position();
    const [buttonX] = closeButton.get_transformed_position();
    const offset = Math.abs((buttonX + closeButton.width / 2) - (boxX + dialogWidth / 2));
    check(offset < 2, `close button centered (off by ${offset.toFixed(1)}px)`);
    const preview = dialog.contentLayout.get_first_child().get_first_child();
    check(Math.abs(ratio(preview) / (800 / 60) - 1) < 0.02,
        `preview keeps the image's shape (${preview.width}x${preview.height})`);
    dialog.close();
    await Scripting.sleep(800);

    // Pinned entries are always listed first
    indicator._runAction(wideItem, 'pin');
    await Scripting.sleep(300);
    const [firstSection] = indicator._listBox.get_children();
    const pinned = indicator._pinnedSection.box.get_children();
    check(firstSection === indicator._pinnedSection.actor && pinned.length === 1 &&
        pinned[0].entry.image === wideItem.entry.image, 'pinned entry shown at the top');
    indicator.menu.close();
    await Scripting.sleep(300);

    // Pasting types Ctrl+V with a keyboard device made on first use
    const pasteTarget = new St.Entry({can_focus: true});
    Main.uiGroup.add_child(pasteTarget);
    const grab = Main.pushModal(pasteTarget);
    pasteTarget.grab_key_focus();
    St.Clipboard.get_default().set_text(CLIPBOARD, 'pasted text');
    await Scripting.sleep(300);
    indicator._paster.paste();
    await Scripting.sleep(800);
    check(pasteTarget.text === 'pasted text', `paste reaches the focused entry (${JSON.stringify(pasteTarget.text)})`);
    Main.popModal(grab);
    pasteTarget.destroy();

    // Adding input devices makes the shell open another menu, so do it first
    const seat = global.stage.get_context().get_backend().get_default_seat();
    const pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    await Scripting.sleep(500);
    Main.panel.menuManager.activeMenu?.close();
    await Scripting.sleep(300);

    // The list shows 12 rows, fewer only when they don't fit in 60% of the screen
    for (let i = 0; i < 40; i++) {
        St.Clipboard.get_default().set_text(CLIPBOARD, `entry ${i}`);
        await Scripting.sleep(60);
    }
    indicator.menu.open();
    await Scripting.sleep(800);
    const list = indicator._scrollView;
    const {vadjustment} = list;
    const textRow = [...indicator._items.values()].find(item => item.entry.kind === 'text');
    const workArea = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
    const rows = Math.max(1, Math.min(12, Math.floor(workArea.height * 0.6 / textRow.height)));
    const separator = indicator._listSeparator.visible ? indicator._listSeparator.height : 0;
    check(Math.abs(list.height - (rows * textRow.height + separator)) < 2 * scale,
        `list shows ${rows} whole rows (${Math.round(list.height)}px, rows ${Math.round(textRow.height)}px)`);
    check(!list.vscrollbar_visible && vadjustment.value === 0, 'scrollbar hidden while idle');

    // Hovering the bottom row highlights it without scrolling
    check(indicator.menu.isOpen, 'menu open');
    const lastVisibleRow = () => {
        const [, listY] = list.get_transformed_position();
        return indicator._historySection.box.get_children().filter(row => {
            const [, y] = row.get_transformed_position();
            return y >= listY - 1 && y + row.height <= listY + list.height + 1;
        }).at(-1);
    };
    const bottomRow = lastVisibleRow();
    const [rowX, rowY] = bottomRow.get_transformed_position();
    for (const dx of [40, 44, 48]) {
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), rowX + dx, rowY + bottomRow.height / 2);
        await Scripting.sleep(100);
    }
    await Scripting.sleep(400);
    check(bottomRow.active, 'hovered row is highlighted');
    check(vadjustment.value === 0, `hovering does not scroll (at ${vadjustment.value}px)`);

    // The wheel scrolls and shows the scrollbar only for a moment
    pointer.notify_discrete_scroll(GLib.get_monotonic_time(),
        Clutter.ScrollDirection.DOWN, Clutter.ScrollSource.WHEEL);
    await Scripting.sleep(300);
    check(vadjustment.value > 0, `wheel scrolls (to ${Math.round(vadjustment.value)}px)`);
    check(list.vscrollbar_visible && indicator._scrollbar.opacity > 0, 'scrollbar shown while scrolling');
    await Scripting.sleep(1500);
    check(!list.vscrollbar_visible, 'scrollbar hidden again after scrolling');

    // Keyboard navigation still scrolls rows into view
    lastVisibleRow().grab_key_focus();
    await Scripting.sleep(500);
    const beforeKeys = vadjustment.value;
    for (let i = 0; i < 2; i++) {
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Down, Clutter.KeyState.PRESSED);
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Down, Clutter.KeyState.RELEASED);
        await Scripting.sleep(300);
    }
    await Scripting.sleep(300);
    check(vadjustment.value > beforeKeys,
        `arrow keys scroll (${Math.round(beforeKeys)} to ${Math.round(vadjustment.value)}px)`);
    indicator.menu.close();
    await Scripting.sleep(300);

    // Text is cut at the entry text length, the menu grows to fit it
    indicator._settings.set_int('preview-length', 100);
    const longText = 'clipboard history entry '.repeat(5).slice(0, 100).trim();
    St.Clipboard.get_default().set_text(CLIPBOARD, longText);
    await Scripting.sleep(500);
    indicator.menu.open();
    await Scripting.sleep(800);
    const longItem = [...indicator._items.values()].find(item => item.entry.text === longText);
    const longLabel = longItem.label_actor;
    check(longLabel.text === longText && !longLabel.clutter_text.get_layout().is_ellipsized(),
        `${longText.length} characters shown in full`);
    const {box} = indicator._menu;
    check(box.width <= workArea.width * 0.7 + 1,
        `menu fits the screen (${Math.round(box.width)}px of ${workArea.width}px)`);
    const icon = longItem.get_last_child().get_first_child().get_first_child();
    check(icon.width === 22 * scale, `action icons are 22px (${icon.width / scale}px)`);

    // Searching does not resize the menu
    const widthBefore = box.width;
    indicator._searchEntry.text = 'entry 1';
    await Scripting.sleep(400);
    // Within a logical pixel, converting to CSS pixels rounds at 2x
    check(Math.abs(box.width - widthBefore) <= scale,
        `menu width stays while searching (${Math.round(widthBefore)} to ${Math.round(box.width)}px)`);
    indicator.menu.close();
    await Scripting.sleep(300);

    // A clear that came due while disabled (screen locked) also empties the clipboard
    const settings = indicator._settings;
    St.Clipboard.get_default().set_text(CLIPBOARD, 'copied before locking');
    await Scripting.sleep(500);
    let menuDestroyed = false;
    let containerDestroyed = false;
    indicator.menu.connect('destroy', () => (menuDestroyed = true));
    indicator.container.connect('destroy', () => (containerDestroyed = true));
    Main.extensionManager.disableExtension(UUID);
    check(await waitForState(ExtensionState.INACTIVE), 'extension disabled');
    check(menuDestroyed && containerDestroyed,
        `disabling destroys the menu (${menuDestroyed}) and panel container (${containerDestroyed})`);
    settings.set_boolean('clear-on-interval', true);
    settings.set_int64('next-clear-time', Math.floor(GLib.get_real_time() / GLib.USEC_PER_SEC) - 10);
    Main.extensionManager.enableExtension(UUID);
    check(await waitForState(ExtensionState.ACTIVE), 'extension enabled again');
    await Scripting.sleep(4000);
    const enabledAgain = Main.panel.statusArea[UUID];
    check(!enabledAgain._store.entries.some(e => e.text === 'copied before locking'),
        'overdue clear removes the entry');
    check(!(await clipboardText()), 'overdue clear empties the clipboard');

    say('ALL PASSED');
}
