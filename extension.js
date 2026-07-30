// SPDX-License-Identifier: GPL-3.0-or-later
//
// Inspired by / Thanks to Clipboard Indicator by Tudmotu:
// https://github.com/Tudmotu/gnome-shell-extension-clipboard-indicator
// Its UI and functionality informed Hushlog's menu layout, scrollable
// history, and clear-history confirmation dialog.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const HISTORY_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'hushlog']);
const HISTORY_FILE = GLib.build_filenamev([HISTORY_DIR, 'history.jsonl']);

const RECENT_MEMORY_LIMIT = 50;
const MENU_COLLAPSE_CHAR_LIMIT = 48;
const MAX_HISTORY_ENTRIES = 500;
const HISTORY_TRIM_BUFFER = 100;

const PAUSED_ICON_OPACITY = 105;
const FULL_ICON_OPACITY = 255;

let interfaceSettings = null;

const HushlogIndicator = GObject.registerClass(
class HushlogIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Hushlog');

        this._extension = extension;
        this._historyItems = [];
        this._searchText = '';

        this._icon = new St.Icon({
            icon_name: 'preferences-system-notifications-symbolic',
            style_class: 'system-status-icon hushlog-panel-icon',
        });

        const box = new St.BoxLayout({
            style_class: 'panel-status-menu-box hushlog-panel-box',
        });
        box.add_child(this._icon);
        this.add_child(box);

        this._buildMenu();
    }

    refresh() {
        this._buildMenu();
    }

    _buildMenu() {
        this.menu.removeAll();
        this._historyItems = [];
        this._searchText = '';
        this._icon.opacity = this._extension.paused
            ? PAUSED_ICON_OPACITY
            : FULL_ICON_OPACITY;

        if (this._extension.paused) {
            this._addActionRows(true);
            return;
        }

        const entries = this._extension.displayedHistory
            .slice(0, this._extension.menuEntryLimit);

        if (entries.length === 0)
            this._addEmptyState();
        else
            this._addHistorySection(entries);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._addActionRows();
    }

    _addHistorySection(entries) {
        this._addSearchRow();

        const section = new PopupMenu.PopupMenuSection();
        for (const entry of entries) {
            const item = new HushlogEntryMenuItem(entry, this._extension);
            item.searchText = entrySearchText(entry);
            this._historyItems.push(item);
            section.addMenuItem(item);
        }

        const scrollView = new St.ScrollView({
            style_class: 'hushlog-history-scroll',
            overlay_scrollbars: false,
        });
        scrollView.add_child(section.actor);

        const scrollSection = new PopupMenu.PopupMenuSection();
        scrollSection.actor.add_child(scrollView);
        this.menu.addMenuItem(scrollSection);
    }

    _addSearchRow() {
        const searchItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });

        this._searchEntry = new St.Entry({
            style_class: 'search-entry hushlog-search-entry',
            hint_text: _('Search notifications...'),
            can_focus: true,
            track_hover: true,
            x_expand: true,
            primary_icon: new St.Icon({icon_name: 'edit-find-symbolic'}),
        });

        this._searchEntry.clutter_text.connectObject('text-changed', () => {
            this._searchText = this._searchEntry.get_text().toLocaleLowerCase();
            this._applySearchFilter();
        }, this);

        searchItem.add_child(this._searchEntry);
        this.menu.addMenuItem(searchItem);
    }

    _addEmptyState() {
        const section = new PopupMenu.PopupMenuSection();
        const emptyState = new St.BoxLayout({
            style_class: 'hushlog-empty-state',
            vertical: true,
        });
        emptyState.add_child(new St.Icon({
            icon_name: 'preferences-system-notifications-symbolic',
            style_class: 'system-status-icon',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        emptyState.add_child(new St.Label({
            text: _('History is empty'),
            x_align: Clutter.ActorAlign.CENTER,
        }));

        section.actor.add_child(emptyState);
        this.menu.addMenuItem(section);
    }

    _addActionRows(pausedOnly = false) {
        const pauseItem = new PopupMenu.PopupSwitchMenuItem(
            _('Private mode'),
            this._extension.paused
        );
        pauseItem.insert_child_at_index(createMenuIcon('security-medium-symbolic'), 0);
        pauseItem.connectObject('toggled', (item, state) => this._extension.setPaused(state), this);
        this.menu.addMenuItem(pauseItem);

        const prefsItem = new PopupMenu.PopupMenuItem(_('Settings'));
        prefsItem.insert_child_at_index(createMenuIcon('preferences-system-symbolic'), 0);
        prefsItem.connectObject('activate', () => this._extension.openPreferences(), this);

        if (pausedOnly) {
            this.menu.addMenuItem(prefsItem);
            return;
        }

        const historyItem = new PopupMenu.PopupMenuItem(_('History'));
        historyItem.insert_child_at_index(createMenuIcon('view-list-symbolic'), 0);
        historyItem.connectObject('activate', () => this._extension.openHistoryDialog(), this);
        this.menu.addMenuItem(historyItem);

        this.menu.addMenuItem(prefsItem);

        if (this._extension.displayedHistory.length > 0) {
            const sweepItem = new PopupMenu.PopupMenuItem(_('Sweep'));
            sweepItem.insert_child_at_index(createMenuIcon('edit-clear-all-symbolic'), 0);
            sweepItem.connectObject('activate', () => this._extension.sweepHistory(), this);
            this.menu.addMenuItem(sweepItem);
        }

        if (this._extension.recentHistory.length > 0) {
            const clearItem = new PopupMenu.PopupMenuItem(_('Clear history'));
            clearItem.insert_child_at_index(createMenuIcon('user-trash-symbolic'), 0);
            clearItem.connectObject('activate', () => this._extension.confirmClearHistory(), this);
            this.menu.addMenuItem(clearItem);
        }
    }

    _applySearchFilter() {
        for (const item of this._historyItems)
            item.visible = this._searchText === '' || item.searchText.includes(this._searchText);
    }
});

const HushlogEntryMenuItem = GObject.registerClass(
class HushlogEntryMenuItem extends PopupMenu.PopupBaseMenuItem {
    _init(entry, extension) {
        super._init({
            reactive: true,
            can_focus: true,
        });

        this._expanded = false;
        this._hasLongContent = isLongEntry(entry);

        this.add_style_class_name('hushlog-entry');

        const outerBox = new St.BoxLayout({
            x_expand: true,
            style_class: 'hushlog-entry-outer',
        });
        outerBox.add_child(createAppIcon(entry));

        const textBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'hushlog-entry-box',
        });

        const header = new St.BoxLayout({
            x_expand: true,
            style_class: 'hushlog-entry-header',
        });
        header.add_child(new St.Label({
            text: truncateText(entry.appName || _('Unknown app'), 36),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'hushlog-app',
        }));
        header.add_child(new St.Label({
            text: formatTime(entry.timestamp),
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'hushlog-time',
        }));
        textBox.add_child(header);

        [this._titleLabel, this._bodyLabel] = createEntryLabels(entry, textBox);
        outerBox.add_child(textBox);
        outerBox.add_child(createEntryActions(entry, () => extension.deleteHistoryEntry(entry)));

        this.add_child(outerBox);
    }

    // PopupBaseMenuItem calls activate() on click and on Enter/Space. Long
    // entries toggle in place instead: not emitting 'activate' keeps the menu
    // open, which is what you want while reading a notification.
    activate(event) {
        if (!this._hasLongContent) {
            super.activate(event);
            return;
        }

        this._expanded = !this._expanded;
        setEntryLabelsCollapsed(this._titleLabel, this._bodyLabel, !this._expanded);
    }
});

export default class HushlogExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._sources = new Set();

        this.recentHistory = [];
        this.sweepBefore = '';
        this._historyLineCount = 0;

        this._loadSettings();
        this._connectSettings();
        this._addIndicator();
        this._loadHistory();
        this._connectMessageTray();
    }

    disable() {
        Main.messageTray.disconnectObject(this);

        for (const source of this._sources)
            source.disconnectObject(this);
        this._sources.clear();

        this._settings.disconnectObject(this);

        if (this._historyDialog) {
            this._historyDialog.close();
            this._historyDialog = null;
        }

        if (this._confirmDialog) {
            this._confirmDialog.close();
            this._confirmDialog = null;
        }

        this._indicator.destroy();
        this._indicator = null;

        this.recentHistory = [];
        this._settings = null;
        interfaceSettings = null;
    }

    get displayedHistory() {
        if (!this.sweepBefore)
            return this.recentHistory;

        return this.recentHistory.filter(entry => entry.timestamp > this.sweepBefore);
    }

    setPaused(paused) {
        this._settings.set_boolean('pause-logging', paused);
    }

    sweepHistory() {
        // Hide everything currently visible without deleting it from the log.
        this.sweepBefore = new Date().toISOString();
        this._refreshIndicator();
    }

    clearHistory() {
        this.recentHistory = [];
        this.sweepBefore = '';
        this._historyLineCount = 0;

        if (!this.sessionOnly) {
            ensureStorageDir();
            writeHistoryFile('');
        }

        this._refreshIndicator();
    }

    async deleteHistoryEntry(entry) {
        if (this.sessionOnly) {
            this.recentHistory = this.recentHistory
                .filter(item => item.localId !== entry.localId);
        } else {
            const entries = (await readHistoryEntries())
                .filter(item => item.localId !== entry.localId);
            if (!this._settings || this.sessionOnly)
                return;

            this._writeHistoryEntries(entries);
            this.recentHistory = entries.reverse().slice(0, RECENT_MEMORY_LIMIT);
        }

        this._refreshIndicator();
    }

    async openHistoryDialog() {
        if (this._historyDialog)
            this._historyDialog.close();

        const entries = await this._historyEntriesNewestFirst();
        if (!this._settings)
            return;

        const dialog = new ModalDialog.ModalDialog({destroyOnClose: true});
        this._historyDialog = dialog;
        dialog.connectObject('closed', () => {
            if (this._historyDialog === dialog)
                this._historyDialog = null;
        }, this);

        const root = new St.BoxLayout({
            vertical: true,
            style_class: 'hushlog-history-dialog',
        });
        root.add_child(new St.Label({
            text: _('Notification History'),
            style_class: 'hushlog-dialog-title',
        }));

        if (entries.length === 0) {
            root.add_child(new St.Label({
                text: _('History is empty'),
                style_class: 'hushlog-dialog-empty',
                x_align: Clutter.ActorAlign.CENTER,
            }));
        } else {
            const list = new St.BoxLayout({
                vertical: true,
                style_class: 'hushlog-dialog-list',
            });
            for (const entry of entries)
                list.add_child(this._createHistoryDialogRow(entry));

            const scrollView = new St.ScrollView({
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                overlay_scrollbars: false,
                style_class: 'hushlog-dialog-scroll',
            });
            scrollView.add_child(list);
            root.add_child(scrollView);
        }

        dialog.contentLayout.add_child(root);
        dialog.addButton({
            label: _('Close'),
            action: () => dialog.close(),
            key: Clutter.KEY_Escape,
        });
        dialog.open();
    }

    confirmClearHistory() {
        if (this._confirmDialog)
            this._confirmDialog.close();

        const dialog = new ModalDialog.ModalDialog({destroyOnClose: true});
        this._confirmDialog = dialog;
        dialog.connectObject('closed', () => {
            if (this._confirmDialog === dialog)
                this._confirmDialog = null;
        }, this);

        const messageBox = new St.BoxLayout({
            vertical: true,
            style_class: 'hushlog-confirm-box',
        });
        messageBox.add_child(new St.Label({
            text: _('Clear notification history?'),
            style_class: 'hushlog-confirm-title',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        messageBox.add_child(new St.Label({
            text: _('This cannot be undone.'),
            style_class: 'hushlog-confirm-subtitle',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        dialog.contentLayout.add_child(messageBox);

        dialog.setButtons([
            {
                label: _('Cancel'),
                action: () => dialog.close(),
                key: Clutter.KEY_Escape,
            },
            {
                label: _('Clear'),
                action: () => {
                    dialog.close();
                    this.clearHistory();
                },
            },
        ]);
        dialog.open();
    }

    _createHistoryDialogRow(entry) {
        const row = new St.BoxLayout({
            style_class: 'hushlog-dialog-entry',
            x_expand: true,
            reactive: true,
            track_hover: true,
        });
        row.add_child(createAppIcon(entry));

        const textBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
        });

        const header = new St.BoxLayout({
            x_expand: true,
            style_class: 'hushlog-entry-header',
        });
        header.add_child(new St.Label({
            text: truncateText(entry.appName || _('Unknown app'), 48),
            x_expand: true,
            style_class: 'hushlog-app',
        }));
        header.add_child(new St.Label({
            text: formatDateTime(entry.timestamp),
            style_class: 'hushlog-time',
        }));
        textBox.add_child(header);

        const [titleLabel, bodyLabel] = createEntryLabels(entry, textBox);
        row.add_child(textBox);

        // Clicking the row expands/collapses long content in place.
        if (isLongEntry(entry)) {
            let expanded = false;
            row.connectObject('button-release-event', () => {
                expanded = !expanded;
                setEntryLabelsCollapsed(titleLabel, bodyLabel, !expanded);
                return Clutter.EVENT_STOP;
            }, row);
        }

        row.add_child(createEntryActions(entry, () => {
            this.deleteHistoryEntry(entry);
            row.destroy();
        }));

        return row;
    }

    async _historyEntriesNewestFirst() {
        if (this.sessionOnly)
            return this.recentHistory.slice();

        return (await readHistoryEntries()).reverse();
    }

    _addIndicator() {
        this._indicator = new HushlogIndicator(this);
        Main.panel.addToStatusArea(
            this.uuid,
            this._indicator,
            this.panelPosition,
            this.panelBox
        );
    }

    _relocateIndicator() {
        this._indicator.destroy();
        this._addIndicator();
    }

    _refreshIndicator() {
        this._indicator.refresh();
    }

    _connectMessageTray() {
        const tray = Main.messageTray;

        tray.connectObject('source-added', (obj, source) => this._watchSource(source), this);
        tray.connectObject('source-removed', (obj, source) => this._unwatchSource(source), this);

        for (const source of tray.getSources())
            this._watchSource(source);
    }

    _watchSource(source) {
        if (this._sources.has(source))
            return;

        source.connectObject('notification-added', (obj, notification) => {
            this._captureNotification(notification, obj);
        }, this);
        this._sources.add(source);
    }

    _unwatchSource(source) {
        if (!this._sources.has(source))
            return;

        source.disconnectObject(this);
        this._sources.delete(source);
    }

    _captureNotification(notification, source) {
        if (this.paused)
            return;

        const entry = entryFromNotification(notification, source);
        if (this._isDenied(entry.appName))
            return;

        this.recentHistory.unshift(entry);
        this.recentHistory = this.recentHistory.slice(0, RECENT_MEMORY_LIMIT);

        this._appendHistory(entry);
        this._refreshIndicator();
    }

    _isDenied(appName) {
        const normalized = appName.toLocaleLowerCase();
        return this.denylist.some(item => normalized.includes(item.toLocaleLowerCase()));
    }

    _appendHistory(entry) {
        if (this.sessionOnly)
            return;

        ensureStorageDir();

        const stream = Gio.File.new_for_path(HISTORY_FILE)
            .append_to(Gio.FileCreateFlags.PRIVATE, null);
        stream.write_all(new TextEncoder().encode(`${JSON.stringify(entry)}\n`), null);
        stream.close(null);

        this._historyLineCount++;
        if (this._historyLineCount > MAX_HISTORY_ENTRIES + HISTORY_TRIM_BUFFER)
            this._trimHistoryFile();
    }

    async _trimHistoryFile() {
        const entries = await readHistoryEntries();
        if (!this._settings || this.sessionOnly)
            return;

        if (entries.length > MAX_HISTORY_ENTRIES)
            this._writeHistoryEntries(entries.slice(-MAX_HISTORY_ENTRIES));
        else
            this._historyLineCount = entries.length;
    }

    _writeHistoryEntries(entries) {
        ensureStorageDir();
        writeHistoryFile(entries.map(entry => `${JSON.stringify(entry)}\n`).join(''));
        this._historyLineCount = entries.length;
    }

    async _loadHistory() {
        if (this.sessionOnly) {
            this._refreshIndicator();
            return;
        }

        const entries = await readHistoryEntries();
        if (!this._settings || this.sessionOnly)
            return;

        this._historyLineCount = entries.length;
        this.recentHistory = entries.reverse().slice(0, RECENT_MEMORY_LIMIT);

        if (this._historyLineCount > MAX_HISTORY_ENTRIES + HISTORY_TRIM_BUFFER)
            this._trimHistoryFile();

        this._refreshIndicator();
    }

    _connectSettings() {
        for (const key of ['pause-logging', 'denylist', 'menu-entry-limit']) {
            this._settings.connectObject(`changed::${key}`, () => {
                this._loadSettings();
                this._refreshIndicator();
            }, this);
        }

        this._settings.connectObject('changed::session-only', () => {
            this._loadSettings();
            this.recentHistory = [];
            this._historyLineCount = 0;
            this._loadHistory();
        }, this);

        for (const key of ['panel-box', 'panel-position']) {
            this._settings.connectObject(`changed::${key}`, () => {
                this._loadSettings();
                this._relocateIndicator();
            }, this);
        }
    }

    _loadSettings() {
        this.paused = this._settings.get_boolean('pause-logging');
        this.sessionOnly = this._settings.get_boolean('session-only');
        this.denylist = this._settings.get_strv('denylist');
        this.menuEntryLimit = this._settings.get_int('menu-entry-limit');
        this.panelBox = this._settings.get_string('panel-box');
        this.panelPosition = this._settings.get_int('panel-position');
    }
}

function ensureStorageDir() {
    GLib.mkdir_with_parents(HISTORY_DIR, 0o700);
}

function writeHistoryFile(text) {
    GLib.file_set_contents(HISTORY_FILE, text);
    GLib.chmod(HISTORY_FILE, 0o600);
}

async function readHistoryEntries() {
    const file = Gio.File.new_for_path(HISTORY_FILE);
    let contents;
    try {
        [, contents] = await new Promise((resolve, reject) => {
            file.load_contents_async(null, (object, result) => {
                try {
                    resolve(object.load_contents_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
        });
    } catch (error) {
        if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return [];

        throw error;
    }

    if (!contents)
        return [];

    return new TextDecoder().decode(contents)
        .split('\n')
        .filter(line => line !== '')
        .map(parseHistoryLine)
        .filter(entry => entry !== null);
}

// The log is a plain file the user may edit or truncate, so a damaged line is
// expected input rather than a programming error: skip it and keep the rest.
function parseHistoryLine(line) {
    try {
        return JSON.parse(line);
    } catch {
        return null;
    }
}

function entryFromNotification(notification, source) {
    const body = notification.body ?? '';
    const icon = notificationIcon(notification, source);

    return {
        localId: GLib.uuid_string_random(),
        timestamp: new Date().toISOString(),
        appName: source.title ?? '',
        icon: icon ? icon.to_string() : null,
        title: notification.title ?? '',
        body: notification.useBodyMarkup ? stripMarkup(body) : body,
    };
}

function notificationIcon(notification, source) {
    if (notification.gicon)
        return notification.gicon;

    if (notification.iconName)
        return new Gio.ThemedIcon({name: notification.iconName});

    return source.icon;
}

function createAppIcon(entry) {
    const icon = new St.Icon({
        style_class: 'hushlog-app-icon',
        y_align: Clutter.ActorAlign.START,
    });

    if (entry.icon)
        icon.gicon = Gio.icon_new_for_string(entry.icon);
    else
        icon.icon_name = 'preferences-system-notifications-symbolic';

    return icon;
}

function createMenuIcon(iconName) {
    return new St.Icon({
        icon_name: iconName,
        style_class: 'hushlog-menu-icon',
        y_align: Clutter.ActorAlign.CENTER,
    });
}

// Renders the title and body rows, collapsed to one line each. A title-only or
// body-only notification gets a single row rather than an empty placeholder.
function createEntryLabels(entry, textBox) {
    let titleLabel = null;
    let bodyLabel = null;

    if (entry.title || !entry.body) {
        titleLabel = createEntryLabel(entry.title || _('(untitled)'), 'hushlog-title');
        textBox.add_child(titleLabel);
    }

    if (entry.body) {
        bodyLabel = createEntryLabel(entry.body, 'hushlog-body');
        textBox.add_child(bodyLabel);
    }

    return [titleLabel, bodyLabel];
}

function createEntryLabel(text, styleClass) {
    const label = new St.Label({
        text,
        x_expand: true,
        style_class: styleClass,
    });
    setLabelCollapsed(label, true);
    return label;
}

function setEntryLabelsCollapsed(titleLabel, bodyLabel, collapsed) {
    if (titleLabel)
        setLabelCollapsed(titleLabel, collapsed);
    if (bodyLabel)
        setLabelCollapsed(bodyLabel, collapsed);
}

function setLabelCollapsed(label, collapsed) {
    const clutterText = label.clutter_text;
    clutterText.single_line_mode = collapsed;
    clutterText.line_wrap = !collapsed;
    clutterText.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    clutterText.ellipsize = collapsed ? Pango.EllipsizeMode.END : Pango.EllipsizeMode.NONE;
}

function createEntryActions(entry, onDelete) {
    const actionsBox = new St.BoxLayout({
        y_align: Clutter.ActorAlign.CENTER,
        style_class: 'hushlog-entry-actions',
    });

    if (entryMessage(entry)) {
        const copyButton = createActionButton('edit-copy-symbolic', _('Copy message'));
        copyButton.connectObject('clicked', () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, entryMessage(entry));
        }, actionsBox);
        actionsBox.add_child(copyButton);
    }

    const deleteButton = createActionButton(
        'edit-delete-symbolic',
        _('Delete notification from history')
    );
    deleteButton.connectObject('clicked', onDelete, actionsBox);
    actionsBox.add_child(deleteButton);

    return actionsBox;
}

function createActionButton(iconName, accessibleName) {
    return new St.Button({
        style_class: 'hushlog-entry-action',
        can_focus: true,
        accessible_name: accessibleName,
        child: new St.Icon({
            icon_name: iconName,
            style_class: 'system-status-icon',
        }),
        y_align: Clutter.ActorAlign.CENTER,
    });
}

// The message is the body; a title-only notification has its title as message.
function entryMessage(entry) {
    return entry.body || entry.title || '';
}

function entrySearchText(entry) {
    return [entry.appName, entry.title, entry.body]
        .join(' ')
        .toLocaleLowerCase();
}

function isLongEntry(entry) {
    return isMultilineOrLong(entry.title) || isMultilineOrLong(entry.body);
}

function isMultilineOrLong(text) {
    return text.includes('\n') ||
        text.replace(/\s+/g, ' ').length > MENU_COLLAPSE_CHAR_LIMIT;
}

function stripMarkup(text) {
    return text.replace(/<[^>]*>/g, '');
}

function truncateText(text, limit) {
    const value = text.replace(/\s+/g, ' ');
    if (value.length <= limit)
        return value;

    return `${value.slice(0, limit - 1)}…`;
}

function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], clockOptions({
        hour: '2-digit',
        minute: '2-digit',
    }));
}

function formatDateTime(timestamp) {
    return new Date(timestamp).toLocaleString([], clockOptions({
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    }));
}

function clockOptions(options) {
    interfaceSettings ??= new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    return {
        ...options,
        hour12: interfaceSettings.get_string('clock-format') === '12h',
    };
}
