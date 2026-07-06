// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const HISTORY_FILE = GLib.build_filenamev([
    GLib.get_user_data_dir(),
    'hushlog',
    'history.jsonl',
]);

export default class HushlogPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._settings = this.getSettings();
        this._blacklistRows = [];

        window.set_title('Hushlog Preferences');

        const page = new Adw.PreferencesPage({
            title: 'Hushlog',
            icon_name: 'preferences-system-notifications-symbolic',
        });

        page.add(this._createGeneralGroup());
        page.add(this._createBlacklistGroup());
        page.add(this._createStorageGroup());

        window.add(page);
    }

    _createGeneralGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'General',
        });

        group.add(this._createSpinRow(
            'Entries shown in menu',
            'How many recent notifications to show before using Show all history.',
            'menu-entry-limit',
            1,
            100
        ));

        return group;
    }

    _createBlacklistGroup() {
        this._blacklistGroup = new Adw.PreferencesGroup({
            title: 'App blacklist',
            description: 'Case-insensitive name fragments. Matching notifications stay out of the log.',
        });

        const addRow = new Adw.EntryRow({
            title: 'Add app or source name',
        });

        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: 'Add',
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
            title: 'Storage',
        });

        const pathRow = new Adw.ActionRow({
            title: 'Log file',
            subtitle: HISTORY_FILE,
        });
        group.add(pathRow);

        const openRow = new Adw.ActionRow({
            title: 'Open log file',
        });
        const openButton = new Gtk.Button({
            icon_name: 'document-open-symbolic',
            tooltip_text: 'Open',
            valign: Gtk.Align.CENTER,
        });
        openButton.add_css_class('flat');
        openButton.connect('clicked', () => this._openLogFile());
        openRow.add_suffix(openButton);
        group.add(openRow);

        const clearRow = new Adw.ActionRow({
            title: 'Clear history',
            subtitle: 'Delete all saved notification history.',
        });
        const clearButton = new Gtk.Button({
            label: 'Clear',
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
        this._settings.connect(`changed::${key}`, () => {
            const value = this._settings.get_int(key);
            if (spin.get_value_as_int() !== value)
                spin.set_value(value);
        });

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
                title: 'No blocked apps',
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
                tooltip_text: 'Remove',
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
}
