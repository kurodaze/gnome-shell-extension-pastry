# Pastry

A clipboard manager for GNOME Shell, written in TypeScript. Supports GNOME 50 and 51.

## Features

* **Image support**: copy and paste images as well as text
* **Pin items**: keep important entries at the top of the menu
* **Search**: find entries by text or tag, including regular expressions
* **Edit entries**: change the text of existing entries
* **Tag entries**: add your own labels to organize the clipboard
* **Keyboard shortcuts**: open or close the menu, cycle through entries and run actions without the mouse
* **Auto-clear history**: clear the history at a regular interval or at boot
* **Private mode**: pause the history while working with sensitive data
* **Exclude apps**: never record copies made while specific applications are focused, such as password managers

Copies that password managers mark as secret (`x-kde-passwordManagerHint`) are never recorded.

### In-menu keyboard controls

| Key | Action |
| --- | --- |
| Arrows | Navigate |
| `Enter` | Copy the entry |
| `Delete` | Delete the entry |
| `v` | Paste the entry into the focused window |
| `p` | Pin or unpin the entry |
| `t` | Tag the entry |
| `h` | Preview the image |
| `e` | Edit the entry |

Typing anything else jumps to the search field. Wrap the search in slashes to use a
regular expression, for example `/^https?:/i`.

### Global shortcuts

None are set by default. Shortcuts for opening the menu, selecting the next or previous
entry, clearing the history and toggling private mode can be set in the preferences.

## Installing

Download `pastry@kurodaze.net.shell-extension.zip` from the
[latest release](https://github.com/kurodaze/gnome-shell-extension-pastry/releases/latest), then:

```sh
gnome-extensions install --force pastry@kurodaze.net.shell-extension.zip
```

Log out and back in, then enable it:

```sh
gnome-extensions enable pastry@kurodaze.net
```

## Building

Requires Node.js, Python 3 and `make`. The only dependencies are the TypeScript compiler and the
[`@girs`](https://github.com/gjsify/types) type definitions, installed without running
any package scripts.

```sh
make            # compile and pack pastry@kurodaze.net.shell-extension.zip
make install    # install it for the current user
make check      # type-check only
make test       # store tests, then an isolated headless GNOME Shell
```

After installing, log out and back in, then enable it:

```sh
make enable
```

## Storage

History is saved to `~/.local/share/pastry/` (`history.json` and an `images/` folder),
readable only by your user. Texts longer than 1,048,576 characters and images above the
configured size limit are not recorded, and the oldest unpinned texts are dropped once they
add up to 16 times that. A history file that can't be read is kept as `history.json.bak`.

## License

GPL v3 or later. See [LICENSE](LICENSE).
