# SPDX-License-Identifier: GPL-3.0-or-later

UUID = hushlog@gagoalaverdyan
EXTENSION_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: install enable disable logs test-notification

install:
	mkdir -p "$(EXTENSION_DIR)"
	cp -r metadata.json extension.js prefs.js stylesheet.css README.md Makefile icons schemas "$(EXTENSION_DIR)/"
	glib-compile-schemas "$(EXTENSION_DIR)/schemas"

enable:
	gnome-extensions enable "$(UUID)"

disable:
	gnome-extensions disable "$(UUID)"

prefs:
	gnome-extensions prefs "$(UUID)"

package:
	glib-compile-schemas schemas
	gnome-extensions pack --force .

logs:
	journalctl -f /usr/bin/gnome-shell

test-notification:
	notify-send "Hushlog test" "This should appear in history"
