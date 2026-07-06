// SPDX-License-Identifier: GPL-3.0-or-later

import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const HISTORY_DIR = GLib.build_filenamev([
    GLib.get_user_data_dir(),
    'hushlog',
]);
const HISTORY_FILE = GLib.build_filenamev([HISTORY_DIR, 'history.jsonl']);

const DEFAULT_MENU_ENTRY_LIMIT = 20;
const RECENT_MEMORY_LIMIT = 50;
const MENU_TITLE_PREVIEW_LIMIT = 96;
const MENU_BODY_PREVIEW_LIMIT = 180;

const HushlogIndicator = GObject.registerClass(
    class HushlogIndicator extends PanelMenu.Button {
        _init(extension) {
            super._init(0.0, 'Hushlog');

            this._extension = extension;
            this._historyItems = [];
            this._searchText = '';

            this._hbox = new St.BoxLayout({
                style_class: 'panel-status-menu-box hushlog-panel-box',
            });

            this._icon = new St.Icon({
                icon_name: 'preferences-system-notifications-symbolic',
                style_class: 'system-status-icon hushlog-panel-icon',
            });
            this._hbox.add_child(this._icon);
            this.add_child(this._hbox);

            this._buildMenu();
        }

        refresh() {
            this._buildMenu();
        }

        _buildMenu() {
            this.menu.removeAll();
            this._historyItems = [];
            this._searchText = '';
            this._syncPausedStyle();

            if (this._extension.paused) {
                this._addActionRows(true);
                return;
            }

            const entries = this._extension.recentHistory.slice(0, this._extension.menuEntryLimit);

            if (entries.length > 0)
                this._addSearchRow();

            this._historySection = new PopupMenu.PopupMenuSection();
            this._historyScrollSection = new PopupMenu.PopupMenuSection();
            this._historyScrollView = new St.ScrollView({
                style_class: 'hushlog-history-scroll',
                overlay_scrollbars: true,
            });
            this._historyScrollView.add_child(this._historySection.actor);
            this._historyScrollSection.actor.add_child(this._historyScrollView);

            if (entries.length === 0)
                this._addEmptyState();
            else {
                for (const entry of entries) {
                    const item = new HushlogEntryMenuItem(entry, this._extension);
                    item.searchText = [
                        entry.appName,
                        entry.title,
                        entry.body,
                        entry.rawSourceTitle,
                    ].map(value => safeString(value).toLocaleLowerCase()).join(' ');

                    this._historyItems.push(item);
                    this._historySection.addMenuItem(item);
                }

                this.menu.addMenuItem(this._historyScrollSection);
            }

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._addActionRows();
            this._applySearchFilter();
        }

        _addSearchRow() {
            const searchItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
            });

            this._searchEntry = new St.Entry({
                name: 'hushlogSearchEntry',
                style_class: 'search-entry hushlog-search-entry',
                hint_text: 'Search notifications...',
                can_focus: true,
                track_hover: true,
                x_expand: true,
                primary_icon: new St.Icon({
                    icon_name: 'edit-find-symbolic',
                }),
            });

            this._searchEntry.get_clutter_text().connect('text-changed', () => {
                this._searchText = this._searchEntry.get_text().toLocaleLowerCase();
                this._applySearchFilter();
            });

            searchItem.add_child(this._searchEntry);
            this.menu.addMenuItem(searchItem);
        }

        _addEmptyState() {
            const emptySection = new PopupMenu.PopupMenuSection();
            const emptyState = new St.BoxLayout({
                style_class: 'hushlog-empty-state',
                vertical: true,
            });
            emptyState.add_child(new St.Icon({
                icon_name: 'preferences-system-notifications-symbolic',
                style_class: 'system-status-icon hushlog-empty-icon',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            emptyState.add_child(new St.Label({
                text: 'No notifications yet',
                x_align: Clutter.ActorAlign.CENTER,
            }));

            emptySection.actor.add_child(emptyState);
            this.menu.addMenuItem(emptySection);
        }

        _addActionRows(pausedOnly = false) {
            const pauseItem = new PopupMenu.PopupSwitchMenuItem(
                'Pause logging',
                this._extension.paused
            );
            pauseItem.insert_child_at_index(createMenuIcon('security-medium-symbolic'), 0);
            pauseItem.connect('toggled', (_item, state) => {
                this._extension.setPaused(state);
            });
            this.menu.addMenuItem(pauseItem);

            const prefsItem = new PopupMenu.PopupMenuItem('Preferences');
            prefsItem.insert_child_at_index(createMenuIcon('preferences-system-symbolic'), 0);
            prefsItem.connect('activate', () => this._extension.openPreferencesWindow());

            if (pausedOnly) {
                this.menu.addMenuItem(prefsItem);
                return;
            }

            const showAllItem = new PopupMenu.PopupMenuItem('Full history');
            showAllItem.insert_child_at_index(createMenuIcon('view-list-symbolic'), 0);
            showAllItem.connect('activate', () => this._extension.openHistoryDialog());
            this.menu.addMenuItem(showAllItem);

            this.menu.addMenuItem(prefsItem);

            const clearItem = new PopupMenu.PopupMenuItem('Clear history');
            clearItem.insert_child_at_index(createMenuIcon('user-trash-symbolic'), 0);
            clearItem.connect('activate', () => this._extension.confirmClearHistory());
            this.menu.addMenuItem(clearItem);
        }

        _syncPausedStyle() {
            this._icon.opacity = this._extension.paused ? 105 : 255;
        }

        _applySearchFilter() {
            if (!this._historyItems)
                return;

            for (const item of this._historyItems)
                item.actor.visible = this._searchText === '' || item.searchText.includes(this._searchText);
        }
    });

const HushlogEntryMenuItem = GObject.registerClass(
    class HushlogEntryMenuItem extends PopupMenu.PopupBaseMenuItem {
        _init(entry, extension) {
            super._init({
                reactive: true,
                can_focus: true,
            });

            this._entry = entry;
            this._expanded = false;
            this._hasLongContent = isLongEntry(entry);

            this.add_style_class_name('hushlog-entry');

            const outerBox = new St.BoxLayout({
                x_expand: true,
                style_class: 'hushlog-entry-outer',
            });

            const box = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style_class: 'hushlog-entry-box',
            });

            const header = new St.BoxLayout({
                x_expand: true,
                style_class: 'hushlog-entry-header',
            });

            const appLabel = new St.Label({
                text: truncateText(entry.appName || 'Unknown app', 36),
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'hushlog-app',
            });
            header.add_child(appLabel);

            const timeLabel = new St.Label({
                text: formatTimestamp(entry.timestamp),
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'hushlog-time',
            });
            header.add_child(timeLabel);

            box.add_child(header);

            this._titleLabel = createEntryLabel({
                text: this._titleText(),
                x_expand: true,
                style_class: 'hushlog-title',
            });
            box.add_child(this._titleLabel);

            if (entry.body) {
                this._bodyLabel = createEntryLabel({
                    text: this._bodyText(),
                    x_expand: true,
                    style_class: 'hushlog-body',
                });
                box.add_child(this._bodyLabel);
            }

            outerBox.add_child(box);

            const actionsBox = new St.BoxLayout({
                vertical: true,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'hushlog-entry-actions',
            });

            if (this._hasLongContent) {
                this._expandIcon = new St.Icon({
                    icon_name: 'pan-down-symbolic',
                    style_class: 'system-status-icon',
                });
                const expandButton = new St.Button({
                    style_class: 'hushlog-entry-action',
                    can_focus: true,
                    accessible_name: 'Expand notification',
                    child: this._expandIcon,
                    x_expand: false,
                    y_expand: false,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                expandButton.connect('clicked', () => this._toggleExpanded());
                actionsBox.add_child(expandButton);
            }

            const deleteButton = new St.Button({
                style_class: 'hushlog-entry-action',
                can_focus: true,
                accessible_name: 'Delete notification from history',
                child: new St.Icon({
                    icon_name: 'edit-delete-symbolic',
                    style_class: 'system-status-icon',
                }),
                x_expand: false,
                y_expand: false,
                y_align: Clutter.ActorAlign.CENTER,
            });
            deleteButton.connect('clicked', () => {
                extension.deleteHistoryEntry(entry);
            });
            actionsBox.add_child(deleteButton);
            outerBox.add_child(actionsBox);

            this.add_child(outerBox);
        }

        _toggleExpanded() {
            this._expanded = !this._expanded;
            this._titleLabel.set_text(this._titleText());
            this._bodyLabel?.set_text(this._bodyText());
            this._expandIcon.icon_name = this._expanded
                ? 'pan-up-symbolic'
                : 'pan-down-symbolic';
        }

        _titleText() {
            const title = this._entry.title || '(untitled)';
            return this._expanded
                ? title
                : truncateText(title, MENU_TITLE_PREVIEW_LIMIT);
        }

        _bodyText() {
            const body = this._entry.body || '';
            return this._expanded
                ? body
                : truncateText(body, MENU_BODY_PREVIEW_LIMIT);
        }
    });

export default class HushlogExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._settingsSignals = [];
        this._loadSettings();

        this.recentHistory = [];
        this._signals = [];
        this._seenNotificationKeys = new Set();

        this._connectSettings();
        this._ensureStorage();
        this._loadHistory();

        this._indicator = new HushlogIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._connectMessageTray();
        this._refreshIndicator();
    }

    disable() {
        this._disconnectSignals();
        this._disconnectSettings();

        if (this._historyDialog) {
            this._historyDialog.close();
            this._historyDialog = null;
        }

        if (this._confirmDialog) {
            this._confirmDialog.close();
            this._confirmDialog = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this.recentHistory = [];
        this._seenNotificationKeys = null;
        this._settings = null;
    }

    getPanelIcon() {
        try {
            return Gio.icon_new_for_string(GLib.build_filenamev([
                this.path,
                'icons',
                'hushlog-symbolic.svg',
            ]));
        } catch (error) {
            logError(error, 'Hushlog: failed to load custom panel icon');
            return Gio.ThemedIcon.new('preferences-system-notifications-symbolic');
        }
    }

    setPaused(paused) {
        this.paused = paused;
        this._settings?.set_boolean('pause-logging', paused);
        this._refreshIndicator();
    }

    openHistoryDialog() {
        try {
            if (this._historyDialog)
                this._historyDialog.close();

            this._historyDialog = new ModalDialog.ModalDialog({
                destroyOnClose: true,
            });
            this._historyDialog.connect('closed', () => {
                this._historyDialog = null;
            });

            const root = new St.BoxLayout({
                vertical: true,
                style_class: 'hushlog-history-dialog',
            });

            root.add_child(new St.Label({
                text: 'Notification History',
                style_class: 'hushlog-dialog-title',
            }));

            const entries = this._readHistoryEntries().reverse();

            if (entries.length === 0) {
                root.add_child(new St.Label({
                    text: 'No notifications yet',
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
                    overlay_scrollbars: true,
                    style_class: 'hushlog-dialog-scroll',
                });
                scrollView.add_child(list);
                root.add_child(scrollView);
            }

            this._historyDialog.contentLayout.add_child(root);
            this._historyDialog.addButton({
                label: 'Close',
                action: () => this._historyDialog?.close(),
                key: Clutter.KEY_Escape,
            });
            this._historyDialog.open();
        } catch (error) {
            logError(error, 'Hushlog: failed to open history dialog');
        }
    }

    _createHistoryDialogRow(entry) {
        const row = new St.BoxLayout({
            style_class: 'hushlog-dialog-entry',
            x_expand: true,
        });

        const textBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
        });

        const header = new St.BoxLayout({
            x_expand: true,
            style_class: 'hushlog-entry-header',
        });
        header.add_child(new St.Label({
            text: truncateText(entry.appName || 'Unknown app', 48),
            x_expand: true,
            style_class: 'hushlog-app',
        }));
        header.add_child(new St.Label({
            text: formatDialogTimestamp(entry.timestamp),
            style_class: 'hushlog-time',
        }));
        textBox.add_child(header);

        textBox.add_child(createEntryLabel({
            text: entry.title || '(untitled)',
            style_class: 'hushlog-title',
        }));

        if (entry.body) {
            textBox.add_child(createEntryLabel({
                text: entry.body,
                style_class: 'hushlog-body',
            }));
        }

        row.add_child(textBox);

        const deleteButton = new St.Button({
            style_class: 'hushlog-entry-action',
            can_focus: true,
            accessible_name: 'Delete notification from history',
            child: new St.Icon({
                icon_name: 'edit-delete-symbolic',
                style_class: 'system-status-icon',
            }),
            x_expand: false,
            y_expand: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        deleteButton.connect('clicked', () => {
            this.deleteHistoryEntry(entry);
            row.destroy();
        });
        row.add_child(deleteButton);

        return row;
    }

    confirmClearHistory() {
        if (this.recentHistory.length === 0 && this._readHistoryEntries().length === 0) {
            this.clearHistory();
            return;
        }

        try {
            if (this._confirmDialog)
                this._confirmDialog.close();

            const dialog = new ModalDialog.ModalDialog({
                destroyOnClose: true,
                styleClass: 'hushlog-confirm-dialog',
            });
            this._confirmDialog = dialog;
            dialog.connect('closed', () => {
                if (this._confirmDialog === dialog)
                    this._confirmDialog = null;
            });

            const messageBox = new St.BoxLayout({
                vertical: true,
                style_class: 'hushlog-confirm-box',
            });
            messageBox.add_child(new St.Label({
                text: 'Clear notification history?',
                style_class: 'hushlog-confirm-title',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            messageBox.add_child(new St.Label({
                text: 'This cannot be undone.',
                style_class: 'hushlog-confirm-subtitle',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            dialog.contentLayout.add_child(messageBox);

            dialog.setButtons([
                {
                    label: 'Cancel',
                    action: () => dialog.close(),
                    key: Clutter.KEY_Escape,
                },
                {
                    label: 'Clear',
                    action: () => {
                        dialog.close();
                        this.clearHistory();
                    },
                },
            ]);

            dialog.open();
        } catch (error) {
            logError(error, 'Hushlog: failed to open clear-history confirmation');
            this.clearHistory();
        }
    }

    clearHistory() {
        this.recentHistory = [];
        this._seenNotificationKeys?.clear();

        try {
            this._ensureStorage();
            GLib.file_set_contents(HISTORY_FILE, '');
        } catch (error) {
            logError(error, 'Hushlog: failed to clear history file');
        }

        this._refreshIndicator();
    }

    deleteHistoryEntry(entry) {
        const targetLocalId = getEntryLocalId(entry);

        try {
            const entries = this._readHistoryEntries()
                .filter(item => getEntryLocalId(item) !== targetLocalId);
            this._writeHistoryEntries(entries);
            this.recentHistory = entries
                .slice()
                .reverse()
                .slice(0, RECENT_MEMORY_LIMIT);
            this._rebuildSeenNotificationKeys();
        } catch (error) {
            logError(error, 'Hushlog: failed to delete history entry');
        }

        this._refreshIndicator();
    }

    openLogFile() {
        try {
            this._ensureStorage();
            const file = Gio.File.new_for_path(HISTORY_FILE);
            Gio.AppInfo.launch_default_for_uri(
                file.get_uri(),
                global.create_app_launch_context(0, -1)
            );
        } catch (error) {
            logError(error, 'Hushlog: failed to open history file');
        }
    }

    openPreferencesWindow() {
        try {
            if (typeof this.openPreferences === 'function')
                this.openPreferences();
        } catch (error) {
            logError(error, 'Hushlog: failed to open preferences');
        }
    }

    _connectMessageTray() {
        const tray = Main.messageTray;
        if (!tray)
            return;

        this._connect(tray, 'source-added', (_tray, source) => {
            this._watchSource(source);
        });

        // GNOME Shell has exposed this signal in recent releases. If it is
        // absent, connect() throws and the source-level fallback remains active.
        try {
            this._connect(tray, 'notification-added', (_tray, notification) => {
                this._captureNotification(notification);
            });
        } catch (error) {
            console.debug(`Hushlog: notification-added unavailable: ${error.message}`);
        }

        for (const source of getExistingSources(tray))
            this._watchSource(source);
    }

    _watchSource(source) {
        if (!source || this._watchedSourceIds?.has(source))
            return;

        if (!this._watchedSourceIds)
            this._watchedSourceIds = new Map();

        const signalIds = [];

        for (const signal of ['notification-added', 'notification-updated']) {
            try {
                const id = source.connect(signal, (_source, notification) => {
                    this._captureNotification(notification, source);
                });
                signalIds.push(id);
            } catch (error) {
                console.debug(`Hushlog: source signal ${signal} unavailable: ${error.message}`);
            }
        }

        this._watchedSourceIds.set(source, signalIds);

        for (const notification of getExistingNotifications(source))
            this._captureNotification(notification, source);
    }

    _captureNotification(notification, fallbackSource = null) {
        if (this.paused || !notification)
            return;

        const entry = this._entryFromNotification(notification, fallbackSource);
        if (this._isDenied(entry.appName) || this._isDenied(entry.rawSourceTitle))
            return;

        const key = buildNotificationKey(entry);
        if (this._seenNotificationKeys.has(key))
            return;
        this._seenNotificationKeys.add(key);

        this.recentHistory.unshift(entry);
        this.recentHistory = this.recentHistory.slice(0, RECENT_MEMORY_LIMIT);

        this._appendHistory(entry);
        this._refreshIndicator();
    }

    _entryFromNotification(notification, fallbackSource) {
        const source = safeValue(notification.source) || fallbackSource;
        const sourceTitle = safeString(source?.title);
        const appName = firstNonEmpty([
            safeString(source?.app?.get_name?.()),
            safeString(source?.app?.get_id?.()),
            safeString(source?.name),
            sourceTitle,
            safeString(notification.sourceName),
            safeString(notification.appName),
        ]) || 'Unknown app';

        const title = firstNonEmpty([
            safeString(notification.title),
            safeString(notification.bannerBodyText),
            safeString(notification.summary),
        ]) || '';

        const body = firstNonEmpty([
            safeString(notification.body),
            safeString(notification.bannerBodyMarkup),
            safeString(notification.acknowledgedBody),
        ]) || '';

        return {
            localId: GLib.uuid_string_random(),
            id: safeString(notification.id) || safeString(notification.residentId) || null,
            timestamp: new Date().toISOString(),
            appName,
            title,
            body: stripMarkup(body),
            urgency: safeString(notification.urgency) || null,
            rawSourceTitle: sourceTitle || null,
        };
    }

    _appendHistory(entry) {
        try {
            this._ensureStorage();
            const file = Gio.File.new_for_path(HISTORY_FILE);
            const stream = file.append_to(
                Gio.FileCreateFlags.PRIVATE,
                null
            );
            const line = `${JSON.stringify(entry)}\n`;
            stream.write_all(new TextEncoder().encode(line), null);
            stream.close(null);
        } catch (error) {
            logError(error, 'Hushlog: failed to append notification history');
        }
    }

    _loadHistory() {
        try {
            const file = Gio.File.new_for_path(HISTORY_FILE);
            if (!file.query_exists(null))
                return;

            this.recentHistory = this._readHistoryEntries()
                .reverse()
                .slice(0, RECENT_MEMORY_LIMIT);

            this._rebuildSeenNotificationKeys();
        } catch (error) {
            logError(error, 'Hushlog: failed to load notification history');
            this.recentHistory = [];
        }
    }

    _readHistoryEntries() {
        this._ensureStorage();

        const file = Gio.File.new_for_path(HISTORY_FILE);
        if (!file.query_exists(null))
            return [];

        const [, contents] = GLib.file_get_contents(HISTORY_FILE);
        const text = new TextDecoder().decode(contents);
        if (text.trim() === '')
            return [];

        const entries = [];
        for (const line of text.split('\n').filter(Boolean)) {
            try {
                entries.push(JSON.parse(line));
            } catch (error) {
                console.debug(`Hushlog: skipped invalid history line: ${error.message}`);
            }
        }

        return entries;
    }

    _writeHistoryEntries(entries) {
        this._ensureStorage();
        const text = entries.length > 0
            ? `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`
            : '';
        GLib.file_set_contents(HISTORY_FILE, text);
    }

    _rebuildSeenNotificationKeys() {
        this._seenNotificationKeys?.clear();

        for (const entry of this.recentHistory)
            this._seenNotificationKeys?.add(buildNotificationKey(entry));
    }

    _ensureStorage() {
        try {
            GLib.mkdir_with_parents(HISTORY_DIR, 0o700);
            GLib.chmod(HISTORY_DIR, 0o700);

            const file = Gio.File.new_for_path(HISTORY_FILE);
            if (!file.query_exists(null))
                GLib.file_set_contents(HISTORY_FILE, '');
        } catch (error) {
            logError(error, 'Hushlog: failed to prepare storage');
        }
    }

    _connect(object, signal, callback) {
        const id = object.connect(signal, callback);
        this._signals.push([object, id]);
        return id;
    }

    _connectSettings() {
        for (const key of [
            'pause-logging',
            'denylist',
            'menu-entry-limit',
        ]) {
            const id = this._settings.connect(`changed::${key}`, () => {
                this._loadSettings();
                this._refreshIndicator();
            });
            this._settingsSignals.push(id);
        }
    }

    _disconnectSettings() {
        if (!this._settings || !this._settingsSignals)
            return;

        for (const id of this._settingsSignals) {
            try {
                this._settings.disconnect(id);
            } catch (error) {
                console.debug(`Hushlog: failed to disconnect settings signal: ${error.message}`);
            }
        }

        this._settingsSignals = [];
    }

    _loadSettings() {
        this.paused = this._settings.get_boolean('pause-logging');
        this.denylist = this._settings.get_strv('denylist');
        this.menuEntryLimit = clamp(
            this._settings.get_int('menu-entry-limit'),
            1,
            100,
            DEFAULT_MENU_ENTRY_LIMIT
        );
    }

    _disconnectSignals() {
        for (const [object, id] of this._signals) {
            try {
                object.disconnect(id);
            } catch (error) {
                console.debug(`Hushlog: failed to disconnect signal: ${error.message}`);
            }
        }
        this._signals = [];

        if (this._watchedSourceIds) {
            for (const [source, ids] of this._watchedSourceIds) {
                for (const id of ids) {
                    try {
                        source.disconnect(id);
                    } catch (error) {
                        console.debug(`Hushlog: failed to disconnect source signal: ${error.message}`);
                    }
                }
            }
            this._watchedSourceIds.clear();
            this._watchedSourceIds = null;
        }
    }

    _isDenied(name) {
        if (!name)
            return false;

        const normalized = name.toLocaleLowerCase();
        return this.denylist.some(item => normalized.includes(item.toLocaleLowerCase()));
    }

    _refreshIndicator() {
        this._indicator?.refresh();
    }
}

function getExistingSources(tray) {
    if (Array.isArray(tray._sources))
        return tray._sources;

    if (tray._sources instanceof Set)
        return [...tray._sources];

    if (tray._sources instanceof Map)
        return [...tray._sources.values()];

    return [];
}

function getExistingNotifications(source) {
    if (Array.isArray(source.notifications))
        return source.notifications;

    if (Array.isArray(source._notifications))
        return source._notifications;

    if (source.notifications instanceof Set)
        return [...source.notifications];

    if (source._notifications instanceof Set)
        return [...source._notifications];

    return [];
}

function firstNonEmpty(values) {
    return values.find(value => value !== null && value !== undefined && value !== '') ?? null;
}

function safeValue(value) {
    try {
        return value ?? null;
    } catch (error) {
        return null;
    }
}

function safeString(value) {
    try {
        if (value === null || value === undefined)
            return '';

        return String(value).trim();
    } catch (error) {
        return '';
    }
}

function stripMarkup(text) {
    return safeString(text).replace(/<[^>]*>/g, '');
}

function truncateText(text, limit) {
    const value = safeString(text).replace(/\s+/g, ' ');
    if (value.length <= limit)
        return value;

    return `${value.slice(0, limit - 3)}...`;
}

function isLongEntry(entry) {
    return safeString(entry.title).replace(/\s+/g, ' ').length > MENU_TITLE_PREVIEW_LIMIT ||
        safeString(entry.body).replace(/\s+/g, ' ').length > MENU_BODY_PREVIEW_LIMIT;
}

function formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime()))
        return '';

    return date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
    });
}

function formatDialogTimestamp(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime()))
        return '';

    return date.toLocaleString([], {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function buildNotificationKey(entry) {
    if (entry.id)
        return [entry.appName || '', entry.id].join('\u001f');

    return [
        entry.appName || '',
        entry.title || '',
        entry.body || '',
    ].join('\u001f');
}

function clamp(value, min, max, fallback) {
    if (!Number.isFinite(value))
        return fallback;

    return Math.min(Math.max(value, min), max);
}

function createMenuIcon(iconName) {
    return new St.Icon({
        icon_name: iconName,
        style_class: 'hushlog-menu-icon',
        y_align: Clutter.ActorAlign.CENTER,
    });
}

function createEntryLabel(params) {
    const label = new St.Label(params);
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    return label;
}

function getEntryLocalId(entry) {
    return entry.localId || [
        entry.timestamp || '',
        entry.id || '',
        entry.appName || '',
        entry.title || '',
        entry.body || '',
    ].join('\u001f');
}
