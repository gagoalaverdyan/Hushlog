# SPDX-License-Identifier: GPL-3.0-or-later

UUID = hushlog@gagoalaverdyan
DOMAIN = hushlog
LINGUAS = en ru
EXTENSION_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: install enable disable prefs package translations logs test-notification

translations:
	@for lang in $(LINGUAS); do \
		mkdir -p "locale/$$lang/LC_MESSAGES"; \
		msgfmt "po/$$lang.po" -o "locale/$$lang/LC_MESSAGES/$(DOMAIN).mo"; \
	done

install: translations
	mkdir -p "$(EXTENSION_DIR)"
	cp -r metadata.json extension.js prefs.js stylesheet.css README.md Makefile media schemas locale "$(EXTENSION_DIR)/"
	glib-compile-schemas "$(EXTENSION_DIR)/schemas"

enable:
	gnome-extensions enable "$(UUID)"

disable:
	gnome-extensions disable "$(UUID)"

prefs:
	gnome-extensions prefs "$(UUID)"

package:
	glib-compile-schemas schemas
	gnome-extensions pack --force --podir=po --gettext-domain="$(DOMAIN)" .

logs:
	journalctl -f /usr/bin/gnome-shell

test-notification:
	notify-send "Hushlog test" "This should appear in history"
