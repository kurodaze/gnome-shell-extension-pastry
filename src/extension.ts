import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {PastryIndicator} from './lib/indicator.js';
import * as Keys from './lib/keys.js';

export default class PastryExtension extends Extension {
    private _indicator: PastryIndicator | null = null;

    override enable() {
        const settings = this.getSettings();
        this._indicator = new PastryIndicator(this, settings);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        const indicator = this._indicator;
        const handlers: Record<Keys.Shortcut, () => void> = {
            [Keys.TOGGLE_MENU]: () => indicator.toggleMenu(),
            [Keys.NEXT_ENTRY]: () => indicator.cycle(1),
            [Keys.PREV_ENTRY]: () => indicator.cycle(-1),
            [Keys.CLEAR_HISTORY]: () => indicator.clearHistory(),
            [Keys.TOGGLE_PRIVATE_MODE]: () => indicator.togglePrivateMode(),
        };
        for (const key of Keys.SHORTCUTS) {
            Main.wm.addKeybinding(key, settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
                handlers[key]);
        }
    }

    override disable() {
        for (const key of Keys.SHORTCUTS)
            Main.wm.removeKeybinding(key);

        this._indicator?.destroy();
        this._indicator = null;
    }
}
