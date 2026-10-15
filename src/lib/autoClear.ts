import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {CLEAR_INTERVAL, CLEAR_ON_INTERVAL, NEXT_CLEAR_TIME} from './keys.js';

// Checked at least this often, so suspend and clock changes are caught up quickly
const MAX_WAIT_SECONDS = 60;
// Gives the indicator time to read the clipboard, so a clear that came due
// while the extension was off also empties it
const FIRST_CHECK_SECONDS = 2;

function now(): number {
    return Math.floor(GLib.get_real_time() / GLib.USEC_PER_SEC);
}

/** Clears the history every `clear-interval` minutes, across restarts. */
export class AutoClear {
    private readonly _settings: Gio.Settings;
    private readonly _clear: () => void;
    private readonly _settingsIds: number[];
    private _timeoutId = 0;

    constructor(settings: Gio.Settings, clear: () => void) {
        this._settings = settings;
        this._clear = clear;
        this._settingsIds = [CLEAR_ON_INTERVAL, CLEAR_INTERVAL].map(key =>
            settings.connect(`changed::${key}`, () => {
                settings.set_int64(NEXT_CLEAR_TIME, 0);
                this._schedule();
            }));
        this._wait(FIRST_CHECK_SECONDS);
    }

    destroy() {
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        this._cancelTimeout();
    }

    private _cancelTimeout() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
    }

    private _schedule() {
        this._cancelTimeout();
        if (!this._settings.get_boolean(CLEAR_ON_INTERVAL))
            return;

        const interval = this._settings.get_int(CLEAR_INTERVAL) * 60;
        const current = now();
        let next = Number(this._settings.get_int64(NEXT_CLEAR_TIME));

        if (next <= 0 || next - current > interval) {
            // Not scheduled yet, or the clock went backwards
            next = current + interval;
            this._settings.set_int64(NEXT_CLEAR_TIME, next);
        } else if (next <= current) {
            this._clear();
            next = current + interval;
            this._settings.set_int64(NEXT_CLEAR_TIME, next);
        }

        this._wait(Math.max(1, Math.min(next - current, MAX_WAIT_SECONDS)));
    }

    private _wait(seconds: number) {
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._timeoutId = 0;
            this._schedule();
            return GLib.SOURCE_REMOVE;
        });
    }
}
