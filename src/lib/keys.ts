// GSettings keys, shared by the extension and the preferences window.

export const HISTORY_SIZE = 'history-size';
export const MOVE_ITEM_FIRST = 'move-item-first';
export const STRIP_TEXT = 'strip-text';
export const TRACK_IMAGES = 'track-images';
export const MAX_IMAGE_SIZE = 'max-image-size';
export const PASTE_ON_SELECT = 'paste-on-select';
export const CONFIRM_CLEAR = 'confirm-clear';

export const DISPLAY_MODE = 'display-mode';
export const TOPBAR_PREVIEW_LENGTH = 'topbar-preview-length';
export const PREVIEW_LENGTH = 'preview-length';
export const NOTIFY_ON_COPY = 'notify-on-copy';
export const NOTIFY_ON_CYCLE = 'notify-on-cycle';

export const PRIVATE_MODE = 'private-mode';
export const EXCLUDED_APPS = 'excluded-apps';

export const CLEAR_ON_BOOT = 'clear-on-boot';
export const CLEAR_ON_INTERVAL = 'clear-on-interval';
export const CLEAR_INTERVAL = 'clear-interval';
export const NEXT_CLEAR_TIME = 'next-clear-time';
export const LAST_BOOT_ID = 'last-boot-id';

export const TOGGLE_MENU = 'toggle-menu';
export const NEXT_ENTRY = 'next-entry';
export const PREV_ENTRY = 'prev-entry';
export const CLEAR_HISTORY = 'clear-history';
export const TOGGLE_PRIVATE_MODE = 'toggle-private-mode';

export const SHORTCUTS = [
    TOGGLE_MENU,
    NEXT_ENTRY,
    PREV_ENTRY,
    CLEAR_HISTORY,
    TOGGLE_PRIVATE_MODE,
] as const;

export type Shortcut = typeof SHORTCUTS[number];

export type DisplayMode = 'icon' | 'text' | 'both';
