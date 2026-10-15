import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GioUnix from 'gi://GioUnix';
import Gtk from 'gi://Gtk?version=4.0';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Keys from './lib/keys.js';

const DISPLAY_MODES: Keys.DisplayMode[] = ['icon', 'text', 'both'];

export default class PastryPreferences extends ExtensionPreferences {
    override async fillPreferencesWindow(window: Adw.PreferencesWindow) {
        const settings = this.getSettings();
        // Keep the settings object alive as long as the window
        (window as Adw.PreferencesWindow & {_settings?: Gio.Settings})._settings = settings;

        const display = Gdk.Display.get_default();
        if (display)
            Gtk.IconTheme.get_for_display(display).add_search_path(GLib.build_filenamev([this.path, 'icons']));

        window.set_default_size(640, 760);
        window.add(this._generalPage(window, settings));
        window.add(this._privacyPage(window, settings));
        window.add(this._shortcutsPage(window, settings));
    }

    private _generalPage(window: Adw.PreferencesWindow, settings: Gio.Settings): Adw.PreferencesPage {
        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'pastry-settings-symbolic',
        });

        const history = new Adw.PreferencesGroup({title: _('History')});
        history.add(spinRow(settings, Keys.HISTORY_SIZE, _('History size'),
            _('Pinned entries do not count towards the limit'), 1, 1000));
        history.add(switchRow(settings, Keys.MOVE_ITEM_FIRST, _('Move selected entry to the top')));
        history.add(switchRow(settings, Keys.PASTE_ON_SELECT, _('Paste when selecting an entry'),
            _('Also paste the entry into the focused window')));
        history.add(switchRow(settings, Keys.STRIP_TEXT, _('Strip whitespace'),
            _('Remove leading and trailing whitespace from copied text')));
        history.add(switchRow(settings, Keys.CONFIRM_CLEAR, _('Confirm before clearing the history')));
        page.add(history);

        const images = new Adw.PreferencesGroup({title: _('Images')});
        images.add(switchRow(settings, Keys.TRACK_IMAGES, _('Keep copied images')));
        const maxSize = spinRow(settings, Keys.MAX_IMAGE_SIZE, _('Largest image'),
            _('In megabytes, bigger images are ignored'), 1, 100);
        settings.bind(Keys.TRACK_IMAGES, maxSize, 'sensitive', Gio.SettingsBindFlags.GET);
        images.add(maxSize);
        page.add(images);

        const appearance = new Adw.PreferencesGroup({title: _('Appearance')});
        const modeRow = new Adw.ComboRow({
            title: _('Top bar shows'),
            model: Gtk.StringList.new([_('Icon'), _('Current entry'), _('Icon and current entry')]),
        });
        const syncMode = () => {
            const index = DISPLAY_MODES.indexOf(settings.get_string(Keys.DISPLAY_MODE) as Keys.DisplayMode);
            modeRow.selected = Math.max(0, index);
        };
        syncMode();
        modeRow.connect('notify::selected', () =>
            settings.set_string(Keys.DISPLAY_MODE, DISPLAY_MODES[modeRow.selected]));
        onChanged(window, settings, Keys.DISPLAY_MODE, syncMode);
        appearance.add(modeRow);

        appearance.add(spinRow(settings, Keys.TOPBAR_PREVIEW_LENGTH, _('Top bar text length'),
            _('In characters'), 5, 100));
        appearance.add(spinRow(settings, Keys.PREVIEW_LENGTH, _('Entry text length'),
            _('In characters'), 10, 500));
        page.add(appearance);

        const notifications = new Adw.PreferencesGroup({title: _('Notifications')});
        notifications.add(switchRow(settings, Keys.NOTIFY_ON_COPY, _('Notify when copying')));
        notifications.add(switchRow(settings, Keys.NOTIFY_ON_CYCLE, _('Show the selected entry when cycling'),
            _('Display an on-screen popup when switching entries with shortcuts')));
        page.add(notifications);

        return page;
    }

    private _privacyPage(window: Adw.PreferencesWindow, settings: Gio.Settings): Adw.PreferencesPage {
        const page = new Adw.PreferencesPage({
            title: _('Privacy'),
            icon_name: 'pastry-private-symbolic',
        });

        const privateGroup = new Adw.PreferencesGroup();
        privateGroup.add(switchRow(settings, Keys.PRIVATE_MODE, _('Private mode'),
            _('Pause the history while working with sensitive data')));
        page.add(privateGroup);

        const clearGroup = new Adw.PreferencesGroup({
            title: _('Automatic clearing'),
            description: _('Pinned entries are always kept'),
        });
        clearGroup.add(switchRow(settings, Keys.CLEAR_ON_BOOT, _('Clear at boot')));
        const intervalRow = new Adw.ExpanderRow({
            title: _('Clear at a regular interval'),
            show_enable_switch: true,
        });
        settings.bind(Keys.CLEAR_ON_INTERVAL, intervalRow, 'enable-expansion', Gio.SettingsBindFlags.DEFAULT);
        intervalRow.add_row(spinRow(settings, Keys.CLEAR_INTERVAL, _('Interval'),
            _('In minutes'), 1, 10080));
        clearGroup.add(intervalRow);
        page.add(clearGroup);

        const appsGroup = new Adw.PreferencesGroup({
            title: _('Excluded applications'),
            description: _('Nothing is recorded while one of these applications is focused. ' +
                'Copies marked as passwords by password managers are always ignored.'),
        });
        page.add(appsGroup);

        let appRows: Gtk.Widget[] = [];
        const addButton = new Adw.ButtonRow({
            title: _('Add Application…'),
            start_icon_name: 'list-add-symbolic',
        });
        addButton.connect('activated', () => {
            pickApplication(window, settings.get_strv(Keys.EXCLUDED_APPS), id => {
                settings.set_strv(Keys.EXCLUDED_APPS, [...settings.get_strv(Keys.EXCLUDED_APPS), id]);
            });
        });

        const syncApps = () => {
            appRows.forEach(row => appsGroup.remove(row));
            appsGroup.remove(addButton);
            appRows = settings.get_strv(Keys.EXCLUDED_APPS).map(id => {
                const row = appRow(id);
                const remove = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    tooltip_text: _('Remove'),
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                remove.connect('clicked', () => {
                    settings.set_strv(Keys.EXCLUDED_APPS,
                        settings.get_strv(Keys.EXCLUDED_APPS).filter(other => other !== id));
                });
                row.add_suffix(remove);
                appsGroup.add(row);
                return row;
            });
            appsGroup.add(addButton);
        };
        syncApps();
        onChanged(window, settings, Keys.EXCLUDED_APPS, syncApps);

        return page;
    }

    private _shortcutsPage(window: Adw.PreferencesWindow, settings: Gio.Settings): Adw.PreferencesPage {
        const page = new Adw.PreferencesPage({
            title: _('Shortcuts'),
            icon_name: 'pastry-keyboard-symbolic',
        });

        const global = new Adw.PreferencesGroup({
            title: _('Global shortcuts'),
            description: _('Click a shortcut to change it'),
        });
        const names: Record<Keys.Shortcut, string> = {
            [Keys.TOGGLE_MENU]: _('Open or close the menu'),
            [Keys.NEXT_ENTRY]: _('Select the next entry'),
            [Keys.PREV_ENTRY]: _('Select the previous entry'),
            [Keys.CLEAR_HISTORY]: _('Clear the history'),
            [Keys.TOGGLE_PRIVATE_MODE]: _('Toggle private mode'),
        };
        for (const key of Keys.SHORTCUTS)
            global.add(shortcutRow(window, settings, key, names[key]));
        page.add(global);

        const menuKeys = new Adw.PreferencesGroup({
            title: _('In the menu'),
            description: _('Type to search. Wrap the search in slashes, like /^https?:/i, to use a regular expression.'),
        });
        const help: [string, string][] = [
            ['Up Down', _('Move between entries')],
            ['Return', _('Copy the entry')],
            ['Delete', _('Delete the entry')],
            ['v', _('Paste the entry into the focused window')],
            ['p', _('Pin or unpin the entry')],
            ['t', _('Tag the entry')],
            ['h', _('Preview the image')],
            ['e', _('Edit the entry')],
        ];
        for (const [accelerator, title] of help) {
            const row = new Adw.ActionRow({title});
            row.add_suffix(new Adw.ShortcutLabel({accelerator, valign: Gtk.Align.CENTER}));
            menuKeys.add(row);
        }
        page.add(menuKeys);

        return page;
    }
}

/** Runs `callback` when `key` changes, for as long as the window is open. */
function onChanged(window: Adw.PreferencesWindow, settings: Gio.Settings, key: string, callback: () => void) {
    const id = settings.connect(`changed::${key}`, callback);
    window.connect('close-request', () => {
        settings.disconnect(id);
        return false;
    });
}

function switchRow(settings: Gio.Settings, key: string, title: string, subtitle?: string): Adw.SwitchRow {
    const row = new Adw.SwitchRow({title, subtitle: subtitle ?? ''});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(
    settings: Gio.Settings, key: string, title: string, subtitle: string, lower: number, upper: number
): Adw.SpinRow {
    const row = Adw.SpinRow.new_with_range(lower, upper, 1);
    row.set({title, subtitle});
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function appRow(id: string): Adw.ActionRow {
    // null when the app was uninstalled after being added
    const info = GioUnix.DesktopAppInfo.new(id) as GioUnix.DesktopAppInfo | null;

    const row = new Adw.ActionRow({
        title: GLib.markup_escape_text(info?.get_display_name() ?? id, -1),
        subtitle: info ? GLib.markup_escape_text(id, -1) : '',
    });
    row.add_prefix(new Gtk.Image({
        gicon: info?.get_icon() ?? Gio.ThemedIcon.new('application-x-executable'),
        icon_size: Gtk.IconSize.LARGE,
    }));
    return row;
}

/** Lets the user choose an installed application. */
function pickApplication(parent: Gtk.Widget, exclude: string[], onPicked: (id: string) => void) {
    const apps = Gio.AppInfo.get_all()
        .filter(app => app.should_show() && app.get_id() && !exclude.includes(app.get_id()!))
        .sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()));

    const dialog = new Adw.Dialog({
        title: _('Add Application'),
        content_width: 420,
        content_height: 560,
    });

    const search = new Gtk.SearchEntry({placeholder_text: _('Search applications')});
    const list = new Gtk.ListBox({
        selection_mode: Gtk.SelectionMode.NONE,
        css_classes: ['boxed-list'],
        margin_top: 12,
        margin_bottom: 12,
        margin_start: 12,
        margin_end: 12,
        valign: Gtk.Align.START,
    });

    const rows = new Map<Gtk.ListBoxRow, Gio.AppInfo>();
    for (const app of apps) {
        const row = new Adw.ActionRow({
            title: GLib.markup_escape_text(app.get_display_name(), -1),
            activatable: true,
        });
        row.add_prefix(new Gtk.Image({
            gicon: app.get_icon() ?? Gio.ThemedIcon.new('application-x-executable'),
            icon_size: Gtk.IconSize.LARGE,
        }));
        row.connect('activated', () => {
            onPicked(app.get_id()!);
            dialog.close();
        });
        rows.set(row, app);
        list.append(row);
    }

    list.set_filter_func(row => {
        const query = search.text.trim().toLowerCase();
        const app = rows.get(row);
        return !query || !app ||
            app.get_display_name().toLowerCase().includes(query) ||
            (app.get_id() ?? '').toLowerCase().includes(query);
    });
    search.connect('search-changed', () => list.invalidate_filter());
    search.connect('activate', () => {
        const first = [...rows.keys()].find(row => row.get_child_visible());
        first?.emit('activate');
    });

    const header = new Adw.HeaderBar();
    const toolbar = new Adw.ToolbarView({
        content: new Gtk.ScrolledWindow({
            child: list,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vexpand: true,
        }),
    });
    toolbar.add_top_bar(header);
    const searchBar = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        margin_start: 12,
        margin_end: 12,
        margin_top: 6,
    });
    searchBar.append(search);
    toolbar.add_top_bar(searchBar);

    dialog.child = toolbar;
    dialog.focus_widget = search;
    dialog.present(parent);
}

/** A row showing a keybinding that can be changed by clicking it. */
function shortcutRow(window: Adw.PreferencesWindow, settings: Gio.Settings, key: string, title: string): Adw.ActionRow {
    const row = new Adw.ActionRow({title, activatable: true});
    const label = new Adw.ShortcutLabel({
        disabled_text: _('Disabled'),
        valign: Gtk.Align.CENTER,
    });
    row.add_suffix(label);

    const sync = () => {
        label.accelerator = settings.get_strv(key)[0] ?? '';
    };
    sync();
    onChanged(window, settings, key, sync);

    row.connect('activated', () => captureShortcut(window, title, accel => {
        settings.set_strv(key, accel ? [accel] : []);
    }));
    return row;
}

/** Waits for a key combination. Backspace disables the shortcut. */
function captureShortcut(window: Adw.PreferencesWindow, title: string, onDone: (accel: string | null) => void) {
    const status = new Adw.StatusPage({
        title,
        description: _('Press the new shortcut, Backspace to disable it, or Escape to cancel'),
        icon_name: 'pastry-keyboard-symbolic',
    });
    const dialog = new Adw.Dialog({
        title: _('Set Shortcut'),
        content_width: 440,
        child: status,
    });

    // Let the shell pass shortcuts it would otherwise handle itself
    const surface = window.get_surface();
    const toplevel = surface instanceof Gdk.Toplevel ? surface : null;
    toplevel?.inhibit_system_shortcuts(null);
    dialog.connect('closed', () => toplevel?.restore_system_shortcuts());

    const controller = new Gtk.EventControllerKey();
    controller.connect('key-pressed', (_controller, keyval: number, _keycode: number, state: Gdk.ModifierType) => {
        const mask = state & Gtk.accelerator_get_default_mod_mask() & ~Gdk.ModifierType.LOCK_MASK;

        if (!mask && keyval === Gdk.KEY_Escape) {
            dialog.close();
            return Gdk.EVENT_STOP;
        }
        if (!mask && keyval === Gdk.KEY_BackSpace) {
            onDone(null);
            dialog.close();
            return Gdk.EVENT_STOP;
        }

        const lower = Gdk.keyval_to_lower(keyval);
        if (!isValidShortcut(lower, mask))
            return Gdk.EVENT_STOP;

        onDone(Gtk.accelerator_name(lower, mask));
        dialog.close();
        return Gdk.EVENT_STOP;
    });
    dialog.add_controller(controller);
    dialog.present(window);
}

function isValidShortcut(keyval: number, mask: Gdk.ModifierType): boolean {
    if (!Gtk.accelerator_valid(keyval, mask))
        return false;

    // Plain keys need a real modifier, except function keys
    const modifiers = Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK | Gdk.ModifierType.SUPER_MASK;
    const isFunctionKey = keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F35;
    return isFunctionKey || (mask & modifiers) !== 0;
}
