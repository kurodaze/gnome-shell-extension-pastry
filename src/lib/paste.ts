import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

// Give the menu time to release its grab so the keys reach the window
const PASTE_DELAY_MS = 150;

// For terminal windows not matched to a desktop file with the TerminalEmulator
// category, compared with the last part of the WM class (org.gnome.Ptyxis -> ptyxis)
const TERMINAL_WM_CLASSES = new Set([
    'terminal', 'console', 'ptyxis', 'xfce4-terminal', 'kitty', 'alacritty',
    'wezterm', 'foot', 'footclient', 'konsole', 'xterm', 'urxvt', 'tilix',
    'terminator', 'ghostty', 'rio',
]);

/** Pastes into the focused window by sending Ctrl+V (Ctrl+Shift+V in terminals). */
export class Paster {
    private _device: Clutter.VirtualInputDevice | null = null;
    private _timeoutId = 0;

    destroy() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        this._device = null;
    }

    paste() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);

        // Only created once pasting is used
        this._device ??= global.stage.get_context().get_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const device = this._device;
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PASTE_DELAY_MS, () => {
            this._timeoutId = 0;
            this._sendShortcut(device);
            return GLib.SOURCE_REMOVE;
        });
    }

    private _sendShortcut(device: Clutter.VirtualInputDevice) {
        const keys = isTerminalFocused()
            ? [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_v]
            : [Clutter.KEY_Control_L, Clutter.KEY_v];
        const time = GLib.get_monotonic_time();

        for (const key of keys)
            device.notify_keyval(time, key, Clutter.KeyState.PRESSED);
        for (const key of keys.reverse())
            device.notify_keyval(time, key, Clutter.KeyState.RELEASED);
    }
}

function isTerminalFocused(): boolean {
    const app = Shell.WindowTracker.get_default().focus_app;
    const categories = app?.get_app_info()?.get_categories() ?? '';
    if (categories.split(';').includes('TerminalEmulator'))
        return true;

    const wmClass = global.display.focus_window?.get_wm_class()?.toLowerCase() ?? '';
    return TERMINAL_WM_CLASSES.has(wmClass.split('.').pop()!);
}
