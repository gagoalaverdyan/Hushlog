// SPDX-License-Identifier: GPL-3.0-or-later
//
// Inspired by / Thanks to Clipboard Indicator by Tudmotu:
// https://github.com/Tudmotu/gnome-shell-extension-clipboard-indicator
// Its UI and functionality informed Hushlog's menu layout, scrollable
// history, and clear-history confirmation dialog.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
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
const MENU_COLLAPSE_CHAR_LIMIT = 48;
const MAX_HISTORY_ENTRIES = 500;
const HISTORY_TRIM_BUFFER = 100;
const APP_INFO_CACHE = new Map();
let interfaceSettings = null;

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

            const entries = this._extension.displayedHistory.slice(0, this._extension.menuEntryLimit);

            if (entries.length > 0)
                this._addSearchRow();

            this._historySection = new PopupMenu.PopupMenuSection();
            this._historyScrollSection = new PopupMenu.PopupMenuSection();
            this._historyScrollView = new St.ScrollView({
                style_class: 'hushlog-history-scroll',
                overlay_scrollbars: false,
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
                hint_text: _('Search notifications...'),
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
                text: _('History is empty'),
                x_align: Clutter.ActorAlign.CENTER,
            }));

            emptySection.actor.add_child(emptyState);
            this.menu.addMenuItem(emptySection);
        }

        _addActionRows(pausedOnly = false) {
            const pauseItem = new PopupMenu.PopupSwitchMenuItem(
                _('Private mode'),
                this._extension.paused
            );
            pauseItem.insert_child_at_index(createMenuIcon('security-medium-symbolic'), 0);
            pauseItem.connect('toggled', (_item, state) => {
                this._extension.setPaused(state);
            });
            this.menu.addMenuItem(pauseItem);

            const prefsItem = new PopupMenu.PopupMenuItem(_('Settings'));
            prefsItem.insert_child_at_index(createMenuIcon('preferences-system-symbolic'), 0);
            prefsItem.connect('activate', () => this._extension.openPreferencesWindow());

            if (pausedOnly) {
                this.menu.addMenuItem(prefsItem);
                return;
            }

            const showAllItem = new PopupMenu.PopupMenuItem(_('History'));
            showAllItem.insert_child_at_index(createMenuIcon('view-list-symbolic'), 0);
            showAllItem.connect('activate', () => this._extension.openHistoryDialog());
            this.menu.addMenuItem(showAllItem);

            this.menu.addMenuItem(prefsItem);

            const hasDisplayed = this._extension.displayedHistory.length > 0;
            const hasHistory = this._extension.recentHistory.length > 0;

            if (hasDisplayed) {
                const sweepItem = new PopupMenu.PopupMenuItem(_('Sweep'));
                sweepItem.insert_child_at_index(createMenuIcon('edit-clear-all-symbolic'), 0);
                sweepItem.connect('activate', () => this._extension.sweepHistory());
                this.menu.addMenuItem(sweepItem);
            }

            if (hasHistory) {
                const clearItem = new PopupMenu.PopupMenuItem(_('Clear history'));
                clearItem.insert_child_at_index(createMenuIcon('user-trash-symbolic'), 0);
                clearItem.connect('activate', () => this._extension.confirmClearHistory());
                this.menu.addMenuItem(clearItem);
            }
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

            outerBox.add_child(createAppIcon(entry));

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
                text: truncateText(entry.appName || _('Unknown app'), 36),
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

            // Only render a title row when there is a title, or when there is
            // nothing else to show. This avoids an empty "(untitled)" line for
            // body-only notifications.
            if (safeString(entry.title) || !safeString(entry.body)) {
                this._titleLabel = createEntryLabel({
                    text: this._titleText(),
                    x_expand: true,
                    style_class: 'hushlog-title',
                });
                this._setLabelCollapsed(this._titleLabel, true);
                box.add_child(this._titleLabel);
            }

            if (entry.body) {
                this._bodyLabel = createEntryLabel({
                    text: this._bodyText(),
                    x_expand: true,
                    style_class: 'hushlog-body',
                });
                this._setLabelCollapsed(this._bodyLabel, true);
                box.add_child(this._bodyLabel);
            }

            outerBox.add_child(box);

            const actionsBox = new St.BoxLayout({
                vertical: false,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'hushlog-entry-actions',
            });

            if (entryMessageText(entry)) {
                const copyButton = new St.Button({
                    style_class: 'hushlog-entry-action',
                    can_focus: true,
                    accessible_name: _('Copy message'),
                    child: new St.Icon({
                        icon_name: 'edit-copy-symbolic',
                        style_class: 'system-status-icon',
                    }),
                    x_expand: false,
                    y_expand: false,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                copyButton.connect('clicked', () => copyMessage(entry));
                actionsBox.add_child(copyButton);
            }

            const deleteButton = new St.Button({
                style_class: 'hushlog-entry-action',
                can_focus: true,
                accessible_name: _('Delete notification from history'),
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

            // Clicking the entry expands/collapses long content in place.
            if (this._hasLongContent)
                this.add_style_class_name('hushlog-entry-expandable');
        }

        // PopupBaseMenuItem calls activate() on click and on Enter/Space. We
        // override it so long entries toggle in place and the menu stays open
        // (we intentionally do not emit 'activate', which would close the menu).
        activate(event) {
            if (this._hasLongContent) {
                this._toggleExpanded();
                return;
            }

            super.activate(event);
        }

        _toggleExpanded() {
            this._expanded = !this._expanded;
            if (this._titleLabel)
                this._setLabelCollapsed(this._titleLabel, !this._expanded);
            if (this._bodyLabel)
                this._setLabelCollapsed(this._bodyLabel, !this._expanded);
            return this._expanded;
        }

        _setLabelCollapsed(label, collapsed) {
            setLabelCollapsed(label, collapsed);
        }

        _titleText() {
            return this._entry.title || '(untitled)';
        }

        _bodyText() {
            return this._entry.body || '';
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
        if (!this.sessionOnly)
            this._ensureStorage();
        this._loadHistory();

        this._addIndicator();

        this._connectMessageTray();
        this._refreshIndicator();
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
        if (!this._indicator)
            return;

        this._indicator.destroy();
        this._indicator = null;
        this._addIndicator();
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

        APP_INFO_CACHE.clear();
        interfaceSettings = null;
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
                text: _('Notification History'),
                style_class: 'hushlog-dialog-title',
            }));

            const entries = this._historyEntriesNewestFirst();

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

            this._historyDialog.contentLayout.add_child(root);
            this._historyDialog.addButton({
                label: _('Close'),
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
            reactive: true,
            track_hover: true,
        });

        const textBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
        });

        row.add_child(createAppIcon(entry));

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
            text: formatDialogTimestamp(entry.timestamp),
            style_class: 'hushlog-time',
        }));
        textBox.add_child(header);

        let titleLabel = null;
        if (safeString(entry.title) || !safeString(entry.body)) {
            titleLabel = createEntryLabel({
                text: entry.title || '(untitled)',
                style_class: 'hushlog-title',
            });
            setLabelCollapsed(titleLabel, true);
            textBox.add_child(titleLabel);
        }

        let bodyLabel = null;
        if (entry.body) {
            bodyLabel = createEntryLabel({
                text: entry.body,
                style_class: 'hushlog-body',
            });
            setLabelCollapsed(bodyLabel, true);
            textBox.add_child(bodyLabel);
        }

        row.add_child(textBox);

        const actionsBox = new St.BoxLayout({
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'hushlog-entry-actions',
        });

        // Clicking the row expands/collapses long content in place.
        if (isLongEntry(entry)) {
            let expanded = false;
            row.add_style_class_name('hushlog-entry-expandable');
            row.connect('button-release-event', () => {
                expanded = !expanded;
                if (titleLabel)
                    setLabelCollapsed(titleLabel, !expanded);
                if (bodyLabel)
                    setLabelCollapsed(bodyLabel, !expanded);
                return Clutter.EVENT_STOP;
            });
        }

        if (entryMessageText(entry)) {
            const copyButton = new St.Button({
                style_class: 'hushlog-entry-action',
                can_focus: true,
                accessible_name: _('Copy message'),
                child: new St.Icon({
                    icon_name: 'edit-copy-symbolic',
                    style_class: 'system-status-icon',
                }),
                x_expand: false,
                y_expand: false,
                y_align: Clutter.ActorAlign.CENTER,
            });
            copyButton.connect('clicked', () => copyMessage(entry));
            actionsBox.add_child(copyButton);
        }

        const deleteButton = new St.Button({
            style_class: 'hushlog-entry-action',
            can_focus: true,
            accessible_name: _('Delete notification from history'),
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
        actionsBox.add_child(deleteButton);

        row.add_child(actionsBox);

        return row;
    }

    get displayedHistory() {
        if (!this.sweepBefore)
            return this.recentHistory;

        return this.recentHistory.filter(
            entry => safeString(entry.timestamp) > this.sweepBefore
        );
    }

    _historyEntriesNewestFirst() {
        if (this.sessionOnly)
            return this.recentHistory.slice();

        return this._readHistoryEntries().reverse();
    }

    _handleSessionOnlyChanged(wasSessionOnly) {
        if (this.sessionOnly === wasSessionOnly)
            return;

        this.recentHistory = [];
        this._seenNotificationKeys?.clear();
        this._historyLineCount = 0;

        if (!this.sessionOnly)
            this._loadHistory();
    }

    sweepHistory() {
        // Hide everything currently visible without deleting it from the log.
        this.sweepBefore = new Date().toISOString();
        this._refreshIndicator();
    }

    confirmClearHistory() {
        if (this._historyEntriesNewestFirst().length === 0) {
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
        } catch (error) {
            logError(error, 'Hushlog: failed to open clear-history confirmation');
            this.clearHistory();
        }
    }

    clearHistory() {
        this.recentHistory = [];
        this._seenNotificationKeys?.clear();

        // A cleared log has nothing left to hide, so drop the sweep marker.
        this.sweepBefore = '';

        try {
            if (!this.sessionOnly) {
                this._ensureStorage();
                GLib.file_set_contents(HISTORY_FILE, '');
            }
            this._historyLineCount = 0;
        } catch (error) {
            logError(error, 'Hushlog: failed to clear history file');
        }

        this._refreshIndicator();
    }

    deleteHistoryEntry(entry) {
        const targetLocalId = getEntryLocalId(entry);

        try {
            if (this.sessionOnly) {
                this.recentHistory = this.recentHistory
                    .filter(item => getEntryLocalId(item) !== targetLocalId);
            } else {
                const entries = this._readHistoryEntries()
                    .filter(item => getEntryLocalId(item) !== targetLocalId);
                this._writeHistoryEntries(entries);
                this.recentHistory = entries
                    .slice()
                    .reverse()
                    .slice(0, RECENT_MEMORY_LIMIT);
            }
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
        ]) || _('Unknown app');

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
            appDesktopId: desktopAppIdFromName(appName) || desktopAppIdFromName(sourceTitle),
            appIconName: iconNameFromNotification(notification, source, appName, sourceTitle),
            title,
            body: stripMarkup(body),
            urgency: safeString(notification.urgency) || null,
            rawSourceTitle: sourceTitle || null,
        };
    }

    _appendHistory(entry) {
        if (this.sessionOnly)
            return;

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

            this._historyLineCount = (this._historyLineCount ?? this._readHistoryEntries().length) + 1;
            if (this._historyLineCount > MAX_HISTORY_ENTRIES + HISTORY_TRIM_BUFFER)
                this._trimHistoryFile();
        } catch (error) {
            logError(error, 'Hushlog: failed to append notification history');
        }
    }

    _trimHistoryFile() {
        const entries = this._readHistoryEntries();
        if (entries.length <= MAX_HISTORY_ENTRIES) {
            this._historyLineCount = entries.length;
            return;
        }

        this._writeHistoryEntries(entries.slice(entries.length - MAX_HISTORY_ENTRIES));
    }

    _loadHistory() {
        if (this.sessionOnly) {
            this._historyLineCount = 0;
            this._rebuildSeenNotificationKeys();
            return;
        }

        try {
            const file = Gio.File.new_for_path(HISTORY_FILE);
            if (!file.query_exists(null))
                return;

            const entries = this._readHistoryEntries();
            this._historyLineCount = entries.length;
            this.recentHistory = entries
                .reverse()
                .slice(0, RECENT_MEMORY_LIMIT);

            this._rebuildSeenNotificationKeys();

            if (this._historyLineCount > MAX_HISTORY_ENTRIES + HISTORY_TRIM_BUFFER)
                this._trimHistoryFile();
        } catch (error) {
            logError(error, 'Hushlog: failed to load notification history');
            this.recentHistory = [];
        }
    }

    _readHistoryEntries() {
        if (this.sessionOnly)
            return [];

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
        if (this.sessionOnly) {
            this._historyLineCount = this.recentHistory.length;
            return;
        }

        this._ensureStorage();
        const text = entries.length > 0
            ? `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`
            : '';
        GLib.file_set_contents(HISTORY_FILE, text);
        this._historyLineCount = entries.length;
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
            GLib.chmod(HISTORY_FILE, 0o600);
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
            'session-only',
        ]) {
            const id = this._settings.connect(`changed::${key}`, () => {
                const wasSessionOnly = this.sessionOnly;
                this._loadSettings();
                if (key === 'session-only')
                    this._handleSessionOnlyChanged(wasSessionOnly);
                this._refreshIndicator();
            });
            this._settingsSignals.push(id);
        }

        for (const key of ['panel-box', 'panel-position']) {
            const id = this._settings.connect(`changed::${key}`, () => {
                this._loadSettings();
                this._relocateIndicator();
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
        this.sessionOnly = this._settings.get_boolean('session-only');
        this.denylist = this._settings.get_strv('denylist');
        this.menuEntryLimit = clamp(
            this._settings.get_int('menu-entry-limit'),
            1,
            100,
            DEFAULT_MENU_ENTRY_LIMIT
        );
        this.sweepBefore ??= '';
        this.panelBox = this._settings.get_string('panel-box');
        this.panelPosition = clamp(
            this._settings.get_int('panel-position'),
            0,
            100,
            0
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

function iconNameFromNotification(notification, source, appName, sourceTitle) {
    return firstNonEmpty([
        desktopAppIconName(appName),
        desktopAppIconName(sourceTitle),
        iconNameFromGIcon(source?.app?.get_app_info?.()?.get_icon?.()),
        normalizeIconName(safeString(source?.app?.get_id?.())),
        iconNameFromGIcon(source?.icon),
        iconNameFromGIcon(source?.gicon),
        normalizeIconName(safeString(source?.iconName)),
        normalizeIconName(safeString(source?.icon_name)),
        iconNameFromGIcon(notification?.gicon),
        iconNameFromGIcon(notification?.icon),
        normalizeIconName(safeString(notification?.iconName)),
        normalizeIconName(safeString(notification?.icon_name)),
    ]);
}

function iconNameForEntry(entry) {
    const storedIconName = normalizeIconName(safeString(entry.appIconName));

    return firstNonEmpty([
        desktopAppIconName(entry.appName),
        desktopAppIconName(entry.rawSourceTitle),
        storedIconName,
        storedIconName ? `${storedIconName}.desktop` : '',
    ]);
}

function shellAppForEntry(entry) {
    try {
        const appSystem = Shell.AppSystem.get_default();
        const storedDesktopId = safeString(entry.appDesktopId);
        const storedIconName = normalizeIconName(safeString(entry.appIconName));
        const desktopIds = [
            storedDesktopId,
            desktopAppIdFromName(entry.appName),
            desktopAppIdFromName(entry.rawSourceTitle),
            storedIconName ? `${storedIconName}.desktop` : '',
        ];

        for (const desktopId of desktopIds) {
            if (!desktopId)
                continue;

            const app = appSystem.lookup_app(desktopId);
            if (app)
                return app;
        }
    } catch (error) {
        return null;
    }

    return null;
}

function desktopAppIdFromName(name) {
    return desktopAppInfo(name).desktopId;
}

function desktopAppIconName(name) {
    return desktopAppInfo(name).iconName;
}

function desktopAppInfo(name) {
    const query = safeString(name);
    if (!query)
        return {desktopId: '', iconName: ''};

    if (APP_INFO_CACHE.has(query))
        return APP_INFO_CACHE.get(query);

    const info = {desktopId: '', iconName: ''};
    try {
        const results = GioUnix.DesktopAppInfo.search(query);
        info.desktopId = results?.[0]?.[0] ?? '';
        const appInfo = info.desktopId ? GioUnix.DesktopAppInfo.new(info.desktopId) : null;
        info.iconName = iconNameFromGIcon(appInfo?.get_icon?.());
    } catch (error) {
        info.desktopId = '';
        info.iconName = '';
    }

    APP_INFO_CACHE.set(query, info);
    return info;
}

function iconNameFromGIcon(icon) {
    try {
        if (!icon)
            return '';

        if (typeof icon.get_names === 'function')
            return firstNonEmpty(icon.get_names().map(name => normalizeIconName(safeString(name))));

        return normalizeIconName(safeString(icon.to_string?.()));
    } catch (error) {
        return '';
    }
}

function normalizeIconName(name) {
    if (!name)
        return '';

    if (name.endsWith('.desktop'))
        return name.slice(0, -'.desktop'.length);

    return name;
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
    return isMultilineOrLong(entry.title) || isMultilineOrLong(entry.body);
}

function isMultilineOrLong(text) {
    const value = safeString(text);
    return /\n/.test(value) ||
        value.replace(/\s+/g, ' ').length > MENU_COLLAPSE_CHAR_LIMIT;
}

function entryMessageText(entry) {
    return [safeString(entry.title), safeString(entry.body)]
        .filter(Boolean)
        .join('\n');
}

function copyMessage(entry) {
    // Copy just the notification's message body. Fall back to the title only
    // when there is no body at all (e.g. title-only notifications).
    const text = safeString(entry.body) || safeString(entry.title);
    if (!text)
        return;

    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
}

function formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime()))
        return '';

    return date.toLocaleTimeString([], clockAwareDateTimeOptions({
        hour: '2-digit',
        minute: '2-digit',
    }));
}

function formatDialogTimestamp(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime()))
        return '';

    return date.toLocaleString([], clockAwareDateTimeOptions({
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    }));
}

function clockAwareDateTimeOptions(options) {
    const clockFormat = getClockFormat();
    if (clockFormat === '12h')
        return {...options, hour12: true};
    if (clockFormat === '24h')
        return {...options, hour12: false};

    return options;
}

function getClockFormat() {
    try {
        interfaceSettings ??= new Gio.Settings({
            schema_id: 'org.gnome.desktop.interface',
        });
        return interfaceSettings.get_string('clock-format');
    } catch (error) {
        return '';
    }
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

function createAppIcon(entry) {
    const app = shellAppForEntry(entry);
    if (app) {
        const icon = app.create_icon_texture(24);
        icon.add_style_class_name?.('hushlog-app-icon');
        icon.y_align = Clutter.ActorAlign.START;
        return icon;
    }

    return new St.Icon({
        icon_name: iconNameForEntry(entry) || 'preferences-system-notifications-symbolic',
        style_class: 'hushlog-app-icon',
        y_align: Clutter.ActorAlign.START,
    });
}

function createEntryLabel(params) {
    const label = new St.Label(params);
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    return label;
}

function setLabelCollapsed(label, collapsed) {
    const clutterText = label.clutter_text;
    if (collapsed) {
        clutterText.single_line_mode = true;
        clutterText.line_wrap = false;
        clutterText.ellipsize = Pango.EllipsizeMode.END;
    } else {
        clutterText.single_line_mode = false;
        clutterText.line_wrap = true;
        clutterText.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        clutterText.ellipsize = Pango.EllipsizeMode.NONE;
    }
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
