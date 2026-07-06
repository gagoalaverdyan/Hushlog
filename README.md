# Hushlog

Hushlog is a small GNOME Shell extension that gives you a local notification history from the top bar.

It is meant to feel like the "notification history" idea on Android: if a notification disappears too quickly, you can open Hushlog and look back. Everything stays on your machine.

Hushlog is early and open to ideas. Suggestions, bug reports, design feedback, and fix requests are welcome.

## What it does

- Adds a compact notification-history indicator to the GNOME top bar.
- Shows recent notifications in a searchable dropdown, with a default menu limit of 20.
- Opens a full-history dialog when you need to look further back.
- Stores history locally as JSON Lines.
- Lets you pause logging when you want quiet/private time.
- Lets you blacklist apps or notification sources.
- Lets you delete individual entries, open the log file, or clear everything.

## Privacy

Hushlog does not send anything anywhere. There is no network code, no sync, no telemetry, and no remote service.

The history file lives here:

```text
~/.local/share/hushlog/history.jsonl
```

The extension creates the directory automatically and tries to keep it private to your user account.

The default blacklist skips common sensitive apps:

```text
Signal
Authenticator
1Password
Bitwarden
KeePassXC
```

You can edit the blacklist from Preferences.

## Requirements

- GNOME Shell 50 or newer
- GJS / GNOME Shell extension support
- `glib-compile-schemas`

## Install from source

Clone the repo, then run:

```sh
make install
```

That copies the extension to:

```text
~/.local/share/gnome-shell/extensions/hushlog@gagoalaverdyan/
```

If GNOME Shell does not notice it immediately, log out and back in.

## Enable

```sh
gnome-extensions enable hushlog@gagoalaverdyan
```

## Open Preferences

```sh
gnome-extensions prefs hushlog@gagoalaverdyan
```

Preferences currently include:

- Number of notifications shown in the menu
- App/source blacklist
- Open or clear the local log file

## Test it

Send a test notification:

```sh
notify-send "Hushlog test" "This should appear in history"
```

Then click the Hushlog icon in the top bar.

Watch GNOME Shell logs while testing:

```sh
journalctl -f /usr/bin/gnome-shell
```

## Reload during development

After editing files:

```sh
make install
gnome-extensions disable hushlog@gagoalaverdyan
gnome-extensions enable hushlog@gagoalaverdyan
```

If styles, metadata, or schemas do not update, log out and back in. GNOME Shell can cache extension state pretty aggressively.

## Package

Create a local install bundle:

```sh
make package
```

This creates:

```text
hushlog@gagoalaverdyan.shell-extension.zip
```

The zip is a build artifact and is ignored by git.

## Uninstall

Disable and remove the extension:

```sh
gnome-extensions disable hushlog@gagoalaverdyan
rm -rf ~/.local/share/gnome-shell/extensions/hushlog@gagoalaverdyan
```

Optionally remove saved history:

```sh
rm -rf ~/.local/share/hushlog
```

## Project layout

```text
metadata.json                                      Extension metadata
extension.js                                       GNOME Shell panel indicator and notification capture
prefs.js                                           Preferences window
stylesheet.css                                     Shell menu styling
schemas/org.gnome.shell.extensions.hushlog.gschema.xml
                                                   GSettings schema
icons/hushlog-symbolic.svg                         Extension icon asset
Makefile                                           Local install and packaging helpers
```

## Contributing

Ideas and fixes are welcome. A good issue includes:

- What you expected to happen
- What actually happened
- Your GNOME Shell version
- Any relevant logs from `journalctl -f /usr/bin/gnome-shell`

Useful contributions right now:

- Better notification capture across GNOME Shell versions
- UI polish that keeps the menu compact and native-looking
- Privacy-focused defaults and blacklist improvements
- Clear bug reports with reproduction steps

## GNOME Shell API notes

Hushlog uses modern GNOME Shell extension APIs and ESM imports:

```js
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
```

The panel indicator is a `PanelMenu.Button` added with `Main.panel.addToStatusArea()`.

Notification capture uses `Main.messageTray`. Hushlog first tries the tray-level `notification-added` signal where available. It also watches existing and newly added MessageTray sources, then listens for source-level `notification-added` and `notification-updated` signals when those are exposed.

GNOME Shell MessageTray internals have changed across releases, so notification field access is intentionally defensive. If Shell 50+ changes signal names again, the extension should still load and unload cleanly, but capture may need a small adapter update in `extension.js`.

## Roadmap ideas

- Export/import controls for the history file.
- A nicer first-run screen explaining privacy and blacklist behavior.
- Better source detection for apps that expose only desktop IDs.
- Extension review checklist for publishing on extensions.gnome.org.

## License

Hushlog is free software licensed under the GNU General Public License v3.0 or later. See [LICENSE](LICENSE).
