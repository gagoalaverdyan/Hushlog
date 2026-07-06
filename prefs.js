// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const HISTORY_FILE = GLib.build_filenamev([
    GLib.get_user_data_dir(),
    'hushlog',
    'history.jsonl',
]);

export default class HushlogPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._settings = this.getSettings();
        this._settingsSignals = [];
        this._blacklistRows = [];

        window.set_title(_('Hushlog Settings'));
        window.connect('close-request', () => {
            this._disconnectSettingsSignals();
            return false;
        });

        const page = new Adw.PreferencesPage({
            title: _('Hushlog'),
            icon_name: 'preferences-system-notifications-symbolic',
        });

        page.add(this._createGeneralGroup());
        page.add(this._createBlacklistGroup());
        page.add(this._createStorageGroup());
        page.add(this._createAboutGroup());

        window.add(page);
    }

    _createAboutGroup() {
        const group = new Adw.PreferencesGroup({
            title: _('About & Credits'),
        });

        group.add(this._createLinkRow(
            _('Report a bug'),
            _('Open an issue on GitHub.'),
            'https://github.com/gagoalaverdyan/Hushlog/issues'
        ));

        group.add(this._createLinkRow(
            _('Inspired by Clipboard Indicator'),
            _("Its UI and functionality informed Hushlog's design."),
            'https://github.com/Tudmotu/gnome-shell-extension-clipboard-indicator'
        ));

        group.add(new Adw.ActionRow({
            title: _('Icons'),
            subtitle: _('From the Adwaita / freedesktop icon set, provided by your GNOME icon theme.'),
        }));

        return group;
    }

    _createLinkRow(title, subtitle, uri) {
        const row = new Adw.ActionRow({
            title,
            subtitle,
            activatable: true,
        });

        row.add_suffix(new Gtk.Image({
            icon_name: 'adw-external-link-symbolic',
            valign: Gtk.Align.CENTER,
        }));
        row.connect('activated', () => this._openUri(uri));

        return row;
    }

    _openUri(uri) {
        try {
            Gtk.show_uri(null, uri, Gdk.CURRENT_TIME);
        } catch (error) {
            console.error(`Hushlog: failed to open URL: ${error.message}`);
        }
    }

    _createGeneralGroup() {
        const group = new Adw.PreferencesGroup({
            title: _('General'),
        });

        group.add(this._createSpinRow(
            _('Entries shown in menu'),
            _('How many recent notifications to show before opening the History view.'),
            'menu-entry-limit',
            1,
            100
        ));

        group.add(this._createPanelBoxRow());

        group.add(this._createSpinRow(
            _('Panel position'),
            _("Order within the panel section. Lower sits closer to the section's inner edge."),
            'panel-position',
            0,
            100
        ));

        return group;
    }

    _createPanelBoxRow() {
        const boxes = ['left', 'center', 'right'];
        const row = new Adw.ComboRow({
            title: _('Panel section'),
            subtitle: _('Which part of the top bar the icon sits in.'),
            model: Gtk.StringList.new([_('Left'), _('Center'), _('Right')]),
        });

        const current = this._settings.get_string('panel-box');
        row.set_selected(Math.max(0, boxes.indexOf(current)));
        row.connect('notify::selected', () => {
            const value = boxes[row.get_selected()] ?? 'right';
            if (this._settings.get_string('panel-box') !== value)
                this._settings.set_string('panel-box', value);
        });
        const id = this._settings.connect('changed::panel-box', () => {
            const index = Math.max(0, boxes.indexOf(this._settings.get_string('panel-box')));
            if (row.get_selected() !== index)
                row.set_selected(index);
        });
        this._settingsSignals.push(id);

        return row;
    }

    _createBlacklistGroup() {
        this._blacklistGroup = new Adw.PreferencesGroup({
            title: _('App blacklist'),
            description: _('Case-insensitive name fragments. Matching notifications stay out of the log.'),
        });

        const addRow = new Adw.EntryRow({
            title: _('Add app or source name'),
        });

        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: _('Add'),
            valign: Gtk.Align.CENTER,
        });
        addButton.add_css_class('flat');
        addButton.connect('clicked', () => {
            this._addBlacklistEntry(addRow.get_text());
            addRow.set_text('');
        });

        addRow.connect('entry-activated', () => {
            this._addBlacklistEntry(addRow.get_text());
            addRow.set_text('');
        });
        addRow.add_suffix(addButton);
        this._blacklistGroup.add(addRow);

        this._refreshBlacklistRows();
        return this._blacklistGroup;
    }

    _createStorageGroup() {
        const group = new Adw.PreferencesGroup({
            title: _('Storage'),
        });

        const sessionOnlyRow = new Adw.SwitchRow({
            title: _('Session only'),
            subtitle: _('Keep new history in memory only.'),
        });
        this._settings.bind(
            'session-only',
            sessionOnlyRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        group.add(sessionOnlyRow);

        const pathRow = new Adw.ActionRow({
            title: _('Log file'),
            subtitle: HISTORY_FILE,
        });
        group.add(pathRow);

        const openRow = new Adw.ActionRow({
            title: _('Open log file'),
        });
        const openButton = new Gtk.Button({
            icon_name: 'document-open-symbolic',
            tooltip_text: _('Open'),
            valign: Gtk.Align.CENTER,
        });
        openButton.add_css_class('flat');
        openButton.connect('clicked', () => this._openLogFile());
        openRow.add_suffix(openButton);
        group.add(openRow);

        const clearRow = new Adw.ActionRow({
            title: _('Clear history'),
            subtitle: _('Delete all saved notification history.'),
        });
        const clearButton = new Gtk.Button({
            label: _('Clear'),
            valign: Gtk.Align.CENTER,
        });
        clearButton.add_css_class('destructive-action');
        clearButton.connect('clicked', () => this._clearHistory());
        clearRow.add_suffix(clearButton);
        group.add(clearRow);

        return group;
    }

    _createSpinRow(title, subtitle, key, min, max) {
        const row = new Adw.ActionRow({title, subtitle});
        const adjustment = new Gtk.Adjustment({
            lower: min,
            upper: max,
            step_increment: 1,
            page_increment: 5,
        });
        const spin = new Gtk.SpinButton({
            adjustment,
            numeric: true,
            valign: Gtk.Align.CENTER,
        });

        spin.set_value(this._settings.get_int(key));
        spin.connect('value-changed', () => {
            this._settings.set_int(key, spin.get_value_as_int());
        });
        const id = this._settings.connect(`changed::${key}`, () => {
            const value = this._settings.get_int(key);
            if (spin.get_value_as_int() !== value)
                spin.set_value(value);
        });
        this._settingsSignals.push(id);

        row.add_suffix(spin);
        return row;
    }

    _addBlacklistEntry(value) {
        const entry = value.trim();
        if (entry.length === 0)
            return;

        const denylist = this._settings.get_strv('denylist');
        if (denylist.some(item => item.toLocaleLowerCase() === entry.toLocaleLowerCase()))
            return;

        this._settings.set_strv('denylist', [...denylist, entry]);
        this._refreshBlacklistRows();
    }

    _refreshBlacklistRows() {
        for (const row of this._blacklistRows)
            this._blacklistGroup.remove(row);

        this._blacklistRows = [];

        const denylist = this._settings.get_strv('denylist');
        if (denylist.length === 0) {
            const row = new Adw.ActionRow({
                title: _('No blocked apps'),
            });
            this._blacklistRows.push(row);
            this._blacklistGroup.add(row);
            return;
        }

        for (const name of denylist) {
            const row = new Adw.ActionRow({
                title: name,
            });

            const removeButton = new Gtk.Button({
                icon_name: 'edit-delete-symbolic',
                tooltip_text: _('Remove'),
                valign: Gtk.Align.CENTER,
            });
            removeButton.add_css_class('flat');
            removeButton.connect('clicked', () => {
                this._settings.set_strv(
                    'denylist',
                    this._settings.get_strv('denylist').filter(item => item !== name)
                );
                this._refreshBlacklistRows();
            });

            row.add_suffix(removeButton);
            this._blacklistRows.push(row);
            this._blacklistGroup.add(row);
        }
    }

    _openLogFile() {
        try {
            const file = Gio.File.new_for_path(HISTORY_FILE);
            Gio.AppInfo.launch_default_for_uri(file.get_uri(), null);
        } catch (error) {
            console.error(`Hushlog: failed to open log file: ${error.message}`);
        }
    }

    _clearHistory() {
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(HISTORY_FILE), 0o700);
            GLib.file_set_contents(HISTORY_FILE, '');
        } catch (error) {
            console.error(`Hushlog: failed to clear history: ${error.message}`);
        }
    }

    _disconnectSettingsSignals() {
        if (!this._settings || !this._settingsSignals)
            return;

        for (const id of this._settingsSignals) {
            try {
                this._settings.disconnect(id);
            } catch (error) {
                console.debug(`Hushlog: failed to disconnect prefs settings signal: ${error.message}`);
            }
        }

        this._settingsSignals = [];
    }
}
