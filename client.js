/**
 * Workspace file quicklook — browser half.
 *
 * Adds two things on top of the shipped right-side document preview:
 *
 * 1. A selection toolbar inside the preview (copy / quote-and-ask / translate).
 *    "Quote and ask" uses the composer's own `insertQuote` so the selected text
 *    lands in the draft exactly like DSH's native message quotes. "Translate"
 *    posts the selection to the Host's one-shot route and shows the result in
 *    a popover beside the selection; it never sends a chat message.
 * 2. A session-level watcher that opens the edited file in the right preview
 *    when the agent finishes a `write` / `edit` / `str_replace_editor` call.
 *    The preview's own auto-refresh then keeps the rendering live.
 *
 * No Host route, vault, or render-source configuration is involved: file reads
 * stay with the shipped preview and the session file system.
 */
window.__ModuleLoader__.load({
  id: 'dsh-file-agentero',
  factory(require) {
    const React = require('react');
    const { createPortal } = require('react-dom');
    const { useCallback, useEffect, useLayoutEffect, useRef, useState } = React;
    const h = React.createElement;

    const NS = 'file-agentero';
    const FOLLOW_KEY = 'dsh-file-agentero.follow';
    /** Latest DSH locale id; the settings tab label is projected outside React. */
    let activeLocale = 'zh';
    const EVENT_SEPARATOR = '\u0000';
    const MAX_QUOTE_LENGTH = 6000;

    const zh = {
      follow: '跟随编辑',
      followOn: '跟随编辑：开（对话里改文件时自动在右侧打开）',
      followOff: '跟随编辑：关（不再自动打开改动的文件）',
      copy: '复制',
      copied: '已复制',
      copyFailed: '复制失败',
      quote: '引用提问',
      quoted: '已引用到输入框',
      quoteFailed: '输入框暂不可用，已复制',
      translate: '翻译',
      translateTitle: '翻译',
      translating: '翻译中…',
      translateFailed: '翻译失败',
      zhToEn: '中 → 英',
      enToZh: '英 → 中',
      retry: '重试',
      close: '关闭',
      copyTranslation: '复制译文',
      liveWrite: '正在写入',
      liveEdit: '正在编辑',
      liveWaiting: '等待模型输出…',
      livePending: '新文件',
      liveHint: '写盘完成后自动打开正式预览',
      liveClose: '关闭',
      updateTab: '版本更新',
      updateIntro: '查看当前版本、安装来源和版本历史，并向 npm registry 检查新版本。本地 link 安装改完插件目录后，重新加载插件即可生效。',
      bundleSummary: '工作区文件预览 · 版本与更新',
      rowVersion: '当前版本',
      rowUpdate: '版本更新',
      rowSource: '安装来源',
      checkNow: '检查更新',
      checkingNow: '检查中…',
      updateTo: '更新到',
      updating: '更新中…',
      updateInstalled: '已更新，重启 DSH 生效',
      updateFailed: '更新失败',
      upToDate: '已是最新版本',
      notPublished: '尚未发布到 npm',
      checkFailed: '暂时无法检查更新',
      neverChecked: '尚未检查',
      lastChecked: '上次检查：',
      sourceRegistry: 'npm registry',
      sourceLocal: '本地文件夹安装（改完插件目录后重新加载）',
      sourceGit: 'Git 安装（git pull 更新）',
      sourceTarball: '压缩包安装',
      sourceUnknown: '未知来源',
      versionHistory: '版本历史',
      noNotes: '暂无更新说明',
      currentTag: '当前',
      updateLoadFailed: '读取版本信息失败',
      repoLink: 'GitHub',
      availableBadge: '可更新',
      selection: '选区操作',
    };

    const en = {
      follow: 'Follow edits',
      followOn: 'Follow edits: on (edited files open in the right preview)',
      followOff: 'Follow edits: off',
      copy: 'Copy',
      copied: 'Copied',
      copyFailed: 'Could not copy',
      quote: 'Quote & ask',
      quoted: 'Quoted into the composer',
      quoteFailed: 'Composer is busy; copied instead',
      translate: 'Translate',
      translateTitle: 'Translation',
      translating: 'Translating…',
      translateFailed: 'Translation failed',
      zhToEn: 'ZH → EN',
      enToZh: 'EN → ZH',
      retry: 'Retry',
      close: 'Close',
      copyTranslation: 'Copy translation',
      liveWrite: 'Writing',
      liveEdit: 'Editing',
      liveWaiting: 'Waiting for the model…',
      livePending: 'New file',
      liveHint: 'The final preview opens when the write lands.',
      liveClose: 'Close',
      updateTab: 'Versions & updates',
      updateIntro: 'Installed version, install source and release history, checked against the npm registry. A linked checkout updates in its own folder; reload the plugin to pick it up.',
      bundleSummary: 'Workspace live preview · versions & updates',
      rowVersion: 'Installed version',
      rowUpdate: 'Version update',
      rowSource: 'Install source',
      checkNow: 'Check for updates',
      checkingNow: 'Checking…',
      updateTo: 'Update to',
      updating: 'Updating…',
      updateInstalled: 'Updated; restart DSH to load it',
      updateFailed: 'Update failed',
      upToDate: 'You are on the latest version',
      notPublished: 'Not published to npm yet',
      checkFailed: 'Could not check for updates right now',
      neverChecked: 'Not checked yet',
      lastChecked: 'Last checked: ',
      sourceRegistry: 'npm registry',
      sourceLocal: 'Local folder install (reload after editing)',
      sourceGit: 'Git install (git pull)',
      sourceTarball: 'Tarball install',
      sourceUnknown: 'Unknown source',
      versionHistory: 'Version history',
      noNotes: 'No release notes',
      currentTag: 'Current',
      updateLoadFailed: 'Could not read version information',
      repoLink: 'GitHub',
      availableBadge: 'Update available',
      selection: 'Selection actions',
    };

    /** Localized copy from the current DSH locale, independent of slot `t` binding. */
    function translate(key) {
      const dict = activeLocale.toLowerCase().startsWith('zh') ? zh : en;
      return dict[key] ?? en[key] ?? key;
    }

    // ---------------------------------------------------------------------
    // Follow-edits preference, shared by the watcher and the header toggle.
    // ---------------------------------------------------------------------

    function readFollow() {
      try {
        return window.localStorage.getItem(FOLLOW_KEY) !== 'off';
      } catch {
        return true;
      }
    }

    const followState = { value: readFollow(), listeners: new Set() };

    function setFollow(value) {
      followState.value = value;
      try {
        window.localStorage.setItem(FOLLOW_KEY, value ? 'on' : 'off');
      } catch {
        // A blocked localStorage must not break the preview.
      }
      for (const listener of followState.listeners) listener(value);
    }

    function useFollow() {
      const [value, setValue] = useState(followState.value);
      useEffect(() => {
        const listener = (next) => setValue(next);
        followState.listeners.add(listener);
        return () => followState.listeners.delete(listener);
      }, []);
      return [value, setFollow];
    }

    // ---------------------------------------------------------------------
    // Resource addresses and mutation extraction.
    // ---------------------------------------------------------------------

    function encodeSegment(segment) {
      return encodeURIComponent(segment).replace(/%3A/gi, ':');
    }

    function fileAddress(sessionId, path) {
      const normalized = String(path).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
      return `dsh-resource://file/session/${encodeSegment(sessionId)}/${normalized
        .split('/')
        .map(encodeSegment)
        .join('/')}`;
    }

    /** Mirrors the Host's direction rule for the "中 → 英 / 英 → 中" label. */
    function translationTarget(text) {
      const cjk = (text.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g) ?? []).length;
      const latin = (text.match(/[A-Za-z]/g) ?? []).length;
      return cjk > 0 && cjk >= latin * 0.2 ? 'en' : 'zh-CN';
    }

    const BINARY_EXTENSIONS = new Set([
      '7z', 'a', 'avi', 'bin', 'bz2', 'class', 'dmg', 'dylib', 'ear', 'exe',
      'flac', 'gz', 'ipa', 'iso', 'jar', 'm4a', 'mkv', 'mov', 'mp3', 'mp4',
      'mpeg', 'mpg', 'o', 'ogg', 'otf', 'pkg', 'rar', 'so', 'tar', 'tgz',
      'ttf', 'wav', 'webm', 'whl', 'woff', 'woff2', 'xz', 'zip',
    ]);

    function renderable(path) {
      const name = String(path).split(/[\\/]/).pop() || '';
      const dot = name.lastIndexOf('.');
      if (dot === -1) return true;
      return !BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
    }

    function absolutePath(value) {
      return (
        typeof value === 'string'
        && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value))
      );
    }

    function parseArguments(raw) {
      if (typeof raw !== 'string') return undefined;
      try {
        const value = JSON.parse(raw);
        return value !== null && typeof value === 'object' && !Array.isArray(value)
          ? value
          : undefined;
      } catch {
        return undefined;
      }
    }

    /**
     * The absolute or workspace-relative target of one successful mutation.
     * Mirrors the shipped changed-files extraction: `meta.path` wins when the
     * Host recorded an absolute target, otherwise the model's arguments do.
     */
    function mutationPath(root) {
      const metaPath = typeof root?.meta?.path === 'string' ? root.meta.path : '';
      const args = parseArguments(root?.call?.argsRaw ?? root?.argsRaw);
      const name = root?.name || root?.call?.name || '';
      let argumentPath = '';
      if (args !== undefined) {
        if (name === 'write') {
          if (typeof args.content === 'string' && typeof args.file_path === 'string') {
            argumentPath = args.file_path;
          }
        } else if (name === 'edit') {
          if (
            typeof args.old_string === 'string'
            && args.old_string.length > 0
            && typeof args.new_string === 'string'
            && args.old_string !== args.new_string
            && typeof args.file_path === 'string'
          ) {
            argumentPath = args.file_path;
          }
        } else if (name === 'str_replace_editor') {
          if (
            (args.command === 'create' || args.command === 'str_replace' || args.command === 'insert')
            && typeof args.path === 'string'
          ) {
            argumentPath = args.path;
          }
        }
      }
      if (absolutePath(argumentPath)) return argumentPath;
      if (absolutePath(metaPath)) return metaPath;
      return argumentPath || metaPath;
    }

    function selectLatestMutation(snapshot) {
      if (snapshot === undefined || snapshot === null || snapshot.nodes === undefined) return '';
      let bestSeq = -1;
      let best = '';
      for (const node of snapshot.nodes.values()) {
        if (node.kind !== 'tool-call') continue;
        const root = node.data?.root;
        if (root === undefined || root === null) continue;
        if (root.kind !== 'tool-result' || root.isError === true) continue;
        const name = root.name || root.call?.name || '';
        const operation = typeof root.meta?.operation === 'string' ? root.meta.operation : '';
        const mutation = name === 'write'
          || name === 'edit'
          || name === 'str_replace_editor'
          || (name === '' && (operation === 'create' || operation === 'str_replace' || operation === 'insert' || operation === 'update'));
        if (!mutation) continue;
        if (typeof root.seq !== 'number' || root.seq <= bestSeq) continue;
        const path = mutationPath(root);
        if (path === '') continue;
        bestSeq = root.seq;
        best = String(root.seq) + EVENT_SEPARATOR + path;
      }
      return best;
    }

    /** Read the streaming text a live mutation would show. */
    function liveContentOf(args, name) {
      if (args === undefined || args === null || typeof args.text !== 'function') return '';
      if (name === 'write') return args.text('content') ?? '';
      return args.text('new_string') ?? args.text('file_text') ?? args.text('content') ?? '';
    }

    /** Read the target path, which may only appear near the end of the JSON. */
    function livePathOf(args) {
      if (args === undefined || args === null || typeof args.text !== 'function') return '';
      return args.text('file_path') ?? args.text('path') ?? '';
    }

    /**
     * A per-component selector for the latest in-flight write/edit call.
     * `select` returns a cheap change key so React re-renders on each delta;
     * `current` holds the mutating call whose PartialArguments has the text.
     */
    function createLiveSelector() {
      const state = { current: null };
      state.select = (snapshot) => {
        if (snapshot === undefined || snapshot === null || snapshot.nodes === undefined) {
          state.current = null;
          return '';
        }
        let best = null;
        for (const node of snapshot.nodes.values()) {
          if (node.kind !== 'tool-call') continue;
          const root = node.data?.root;
          if (root === undefined || root === null) continue;
          if (root.kind === 'tool-result' || root.isError === true) continue;
          const name = root.name || root.call?.name || '';
          if (name !== 'write' && name !== 'edit' && name !== 'str_replace_editor') continue;
          const args = root.args;
          if (!args || typeof args.text !== 'function') continue;
          const time = typeof root.time === 'number' ? root.time : 0;
          if (best !== null && time < best.time) continue;
          best = {
            root,
            time,
            name,
            content: liveContentOf(args, name),
            path: livePathOf(args),
          };
        }
        if (best === null) {
          state.current = null;
          return '';
        }
        state.current = best.root;
        return `${best.root.callId}\u0000${best.name}\u0000${best.content.length}\u0000${best.path}`;
      };
      return state;
    }

    // ---------------------------------------------------------------------
    // Styles. Kept in one effect-owned <style> so unmounting removes them.
    // ---------------------------------------------------------------------

    const STYLE_ID = 'file-agentero-style';
    const STYLE_TEXT = `
      .fa-bar, .fa-notice {
        position: fixed;
        z-index: 2147483000;
        display: flex;
        align-items: center;
        gap: 2px;
        padding: 4px;
        border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28));
        border-radius: 10px;
        background: var(--dsw-alias-bg-overlay, Canvas);
        color: var(--dsw-alias-label-primary, CanvasText);
        box-shadow: 0 8px 24px rgba(0, 0, 0, .18);
        font: 12px/1.2 var(--font-sans, system-ui, sans-serif);
        white-space: nowrap;
      }
      .fa-notice {
        pointer-events: none;
        padding: 6px 10px;
        color: var(--dsw-alias-label-secondary, GrayText);
      }
      .fa-bar button {
        appearance: none;
        border: 0;
        background: transparent;
        color: inherit;
        padding: 5px 8px;
        border-radius: 6px;
        cursor: pointer;
        font: inherit;
      }
      .fa-bar button:hover {
        background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14));
      }
      .fa-bar button:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary, Highlight);
        outline-offset: 1px;
      }
      .fa-head {
        appearance: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        border: 0;
        border-radius: 9px;
        background: transparent;
        color: var(--dsw-alias-label-secondary, GrayText);
        cursor: pointer;
      }
      .fa-head:hover {
        background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14));
        color: var(--dsw-alias-label-primary, CanvasText);
      }
      .fa-head[aria-pressed="true"] {
        color: var(--dsw-alias-brand-primary, Highlight);
      }
      .fa-head[aria-pressed="false"] {
        opacity: .5;
      }
      .fa-head:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary, Highlight);
        outline-offset: 1px;
      }
      .fa-card {
        position: fixed;
        z-index: 2147483001;
        display: flex;
        flex-direction: column;
        max-height: min(60vh, 420px);
        overflow: hidden;
        border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28));
        border-radius: 12px;
        background: var(--dsw-alias-bg-overlay, Canvas);
        color: var(--dsw-alias-label-primary, CanvasText);
        box-shadow: 0 12px 32px rgba(0, 0, 0, .22);
        font: 13px/1.55 var(--font-sans, system-ui, sans-serif);
      }
      .fa-card-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2));
        color: var(--dsw-alias-label-secondary, GrayText);
        font-size: 12px;
      }
      .fa-card-title {
        font-weight: 600;
        color: var(--dsw-alias-label-primary, CanvasText);
      }
      .fa-card-dir {
        margin-left: auto;
        padding: 1px 7px;
        border-radius: 999px;
        background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14));
        font-size: 11px;
      }
      .fa-card-close {
        appearance: none;
        border: 0;
        background: transparent;
        color: inherit;
        width: 22px;
        height: 22px;
        padding: 0;
        border-radius: 6px;
        cursor: pointer;
        font-size: 15px;
        line-height: 1;
      }
      .fa-card-close:hover {
        background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14));
        color: var(--dsw-alias-label-primary, CanvasText);
      }
      .fa-card-body {
        flex: 1;
        min-height: 48px;
        overflow: auto;
        padding: 10px 12px;
        white-space: pre-wrap;
        word-break: break-word;
        user-select: text;
      }
      .fa-card-muted {
        color: var(--dsw-alias-label-secondary, GrayText);
      }
      .fa-card-error {
        color: var(--dsw-alias-state-error-primary, #c0392b);
      }
      .fa-card-actions {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
        padding: 6px 8px;
        border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2));
      }
      .fa-card-actions button {
        appearance: none;
        border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28));
        border-radius: 7px;
        background: transparent;
        color: inherit;
        padding: 4px 9px;
        cursor: pointer;
        font: inherit;
      }
      .fa-card-actions button:hover {
        background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14));
      }
      .fa-live {
        position: fixed;
        top: 76px;
        right: 24px;
        z-index: 2147482990;
        display: flex;
        flex-direction: column;
        width: min(560px, calc(100vw - 48px));
        max-height: min(70vh, 680px);
        overflow: hidden;
        border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28));
        border-radius: 12px;
        background: var(--dsw-alias-bg-overlay, Canvas);
        color: var(--dsw-alias-label-primary, CanvasText);
        box-shadow: 0 18px 46px rgba(0, 0, 0, .26);
        font: 12px/1.5 var(--font-sans, system-ui, sans-serif);
      }
      .fa-live-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2));
      }
      .fa-live-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--dsw-alias-brand-primary, Highlight);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary, Highlight) 18%, transparent);
      }
      .fa-live-title {
        font-weight: 600;
        color: var(--dsw-alias-label-primary, CanvasText);
      }
      .fa-live-file {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--dsw-alias-label-secondary, GrayText);
      }
      .fa-live-count {
        margin-left: auto;
        color: var(--dsw-alias-label-secondary, GrayText);
        font-variant-numeric: tabular-nums;
      }
      .fa-live-close {
        appearance: none;
        border: 0;
        background: transparent;
        color: inherit;
        width: 22px;
        height: 22px;
        padding: 0;
        border-radius: 6px;
        cursor: pointer;
        font-size: 15px;
        line-height: 1;
      }
      .fa-live-close:hover {
        background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14));
      }
      .fa-live-body {
        flex: 1;
        min-height: 64px;
        overflow: auto;
        padding: 10px 12px;
        background: var(--dsw-alias-bg-base, Canvas);
      }
      .fa-live-muted {
        color: var(--dsw-alias-label-secondary, GrayText);
      }
      .fa-live-code {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font: 12px/1.55 var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        color: var(--dsw-alias-label-primary, CanvasText);
      }
      .fa-live-diff {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .fa-live-diff pre {
        margin: 0;
        padding: 6px 8px;
        border-radius: 7px;
        white-space: pre-wrap;
        word-break: break-word;
        font: 12px/1.55 var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
      }
      .fa-live-old {
        color: var(--dsw-alias-label-secondary, GrayText);
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c0392b) 8%, transparent);
      }
      .fa-live-new {
        color: var(--dsw-alias-label-primary, CanvasText);
        background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2e7d32) 9%, transparent);
      }
      .fa-live-foot {
        padding: 6px 10px;
        border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2));
        color: var(--dsw-alias-label-secondary, GrayText);
      }
      .fa-set {
        display: flex;
        flex-direction: column;
        gap: 14px;
        padding: 4px 2px 20px;
        color: var(--dsw-alias-label-primary, CanvasText);
        font: 13px/1.55 var(--font-sans, system-ui, sans-serif);
      }
      .fa-set-title {
        margin: 0;
        font-size: 15px;
        font-weight: 650;
        letter-spacing: -0.01em;
      }
      .fa-set-intro {
        margin: 0;
        max-width: 720px;
        color: var(--dsw-alias-label-secondary, GrayText);
      }
      .fa-set-rows {
        display: flex;
        flex-direction: column;
        border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.24));
        border-radius: 10px;
        overflow: hidden;
      }
      .fa-set-row {
        display: flex;
        align-items: center;
        gap: 16px;
        padding: 10px 12px;
        border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.16));
      }
      .fa-set-row:last-child { border-bottom: none; }
      .fa-set-row-text {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
        flex: 1;
      }
      .fa-set-row-title { font-weight: 600; }
      .fa-set-row-desc {
        color: var(--dsw-alias-label-secondary, GrayText);
        font-size: 12px;
        overflow-wrap: anywhere;
      }
      .fa-set-row-control { flex-shrink: 0; }
      .fa-set-btn {
        appearance: none;
        border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3));
        border-radius: 8px;
        background: transparent;
        color: inherit;
        padding: 5px 11px;
        cursor: pointer;
        font: inherit;
      }
      .fa-set-btn:hover { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14)); }
      .fa-set-btn:disabled { opacity: .55; cursor: default; }
      .fa-set-btn--primary {
        border-color: transparent;
        background: var(--dsw-alias-brand-primary, #4f7cff);
        color: #fff;
      }
      .fa-set-btn--primary:hover { filter: brightness(1.06); }
      .fa-set-version-line {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .fa-set-version-no {
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .fa-set-badge, .fa-set-tag {
        padding: 1px 7px;
        border-radius: 999px;
        background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14));
        color: var(--dsw-alias-label-secondary, GrayText);
        font-size: 11px;
      }
      .fa-set-badge {
        color: var(--dsw-alias-brand-primary, #4f7cff);
        background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 12%, transparent);
      }
      .fa-set-link {
        color: var(--dsw-alias-brand-primary, #4f7cff);
        text-decoration: none;
      }
      .fa-set-link:hover { text-decoration: underline; }
      .fa-set-history {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .fa-set-history-title {
        margin: 0;
        font-size: 13px;
        font-weight: 600;
      }
      .fa-set-version {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 8px 0;
        border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14));
      }
      .fa-set-version:last-child { border-bottom: none; }
      .fa-set-version-line {
        display: flex;
        align-items: baseline;
        gap: 8px;
        flex-wrap: wrap;
      }
      .fa-set-version-date {
        color: var(--dsw-alias-label-secondary, GrayText);
        font-size: 12px;
      }
      .fa-set-notes {
        margin: 0;
        padding-left: 18px;
        color: var(--dsw-alias-label-secondary, GrayText);
      }
      .fa-set-empty {
        color: var(--dsw-alias-label-secondary, GrayText);
        font-size: 12px;
      }
      .fa-set-error {
        color: var(--dsw-alias-state-error-primary, #c0392b);
      }
    `;

    function installStyles() {
      let style = document.getElementById(STYLE_ID);
      if (style === null) {
        style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = STYLE_TEXT;
        document.head.appendChild(style);
      }
      return () => {
        const current = document.getElementById(STYLE_ID);
        if (current !== null) current.remove();
      };
    }

    // ---------------------------------------------------------------------
    // Selection toolbar (mounted from the preview header's action slot).
    // ---------------------------------------------------------------------

    function createPreviewTools(ctx) {
      return function PreviewTools(props) {
        const { inputActions } = props;
        const tr = useCallback(translate, []);
        const [follow, toggleFollow] = useFollow();
        const rootRef = useRef(null);
        const panelRef = useRef(null);
        const targetRef = useRef(null);
        const noticeTimer = useRef(0);
        const translateAbort = useRef(null);
        const cardRef = useRef(null);
        const [target, setTargetState] = useState(null);
        const [notice, setNotice] = useState(null);
        const [card, setCard] = useState(null);

        const remember = useCallback((next) => {
          targetRef.current = next;
          setTargetState(next);
        }, []);

        const flash = useCallback((text) => {
          const anchor = targetRef.current ?? { x: window.innerWidth / 2, y: 120, bottom: 140 };
          setNotice({ text, x: anchor.x, y: anchor.y, bottom: anchor.bottom });
          clearTimeout(noticeTimer.current);
          noticeTimer.current = setTimeout(() => setNotice(null), 1600);
        }, []);

        useEffect(() => () => {
          clearTimeout(noticeTimer.current);
          translateAbort.current?.abort();
        }, []);

        useLayoutEffect(() => {
          const element = rootRef.current;
          panelRef.current = element === null ? null : element.closest('[data-sidebar-right-panel]');
        }, []);

        useEffect(() => {
          const panel = panelRef.current;
          if (panel === null) return undefined;
          let frame = 0;

          const clear = () => remember(null);
          const read = () => {
            const selection = window.getSelection();
            if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
              clear();
              return;
            }
            const text = selection.toString().replace(/\s+/g, ' ').trim();
            if (text === '' || text.length > MAX_QUOTE_LENGTH) {
              clear();
              return;
            }
            const range = selection.getRangeAt(0);
            const start = range.startContainer;
            const element = start.nodeType === 1 ? start : start.parentElement;
            if (element === null || !panel.contains(element)) {
              clear();
              return;
            }
            if (element.closest('[data-textpreview-content]') === null) {
              clear();
              return;
            }
            if (element.closest('input, textarea, select, [contenteditable="true"]') !== null) {
              clear();
              return;
            }
            const rect = range.getBoundingClientRect();
            if (!Number.isFinite(rect.top) || (rect.width === 0 && rect.height === 0)) {
              clear();
              return;
            }
            remember({
              text,
              x: rect.left + rect.width / 2,
              y: rect.top,
              bottom: rect.bottom,
            });
          };

          const schedule = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(read);
          };

          const onKeyDown = (event) => {
            if (event.key !== 'Escape') return;
            clear();
            translateAbort.current?.abort();
            setCard(null);
          };

          document.addEventListener('selectionchange', schedule);
          document.addEventListener('mouseup', schedule, true);
          document.addEventListener('keyup', schedule, true);
          document.addEventListener('keydown', onKeyDown);
          document.addEventListener('scroll', clear, true);
          window.addEventListener('resize', clear);
          return () => {
            cancelAnimationFrame(frame);
            document.removeEventListener('selectionchange', schedule);
            document.removeEventListener('mouseup', schedule, true);
            document.removeEventListener('keyup', schedule, true);
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('scroll', clear, true);
            window.removeEventListener('resize', clear);
          };
        }, [remember]);

        useEffect(() => {
          if (card === null) return undefined;
          const onPointerDown = (event) => {
            if (cardRef.current !== null && cardRef.current.contains(event.target)) return;
            translateAbort.current?.abort();
            setCard(null);
          };
          document.addEventListener('pointerdown', onPointerDown, true);
          return () => document.removeEventListener('pointerdown', onPointerDown, true);
        }, [card]);

        const copy = useCallback(async (text) => {
          try {
            await navigator.clipboard.writeText(text);
            flash(tr('copied'));
            return true;
          } catch {
            try {
              const area = document.createElement('textarea');
              area.value = text;
              area.style.position = 'fixed';
              area.style.opacity = '0';
              document.body.appendChild(area);
              area.select();
              const copied = document.execCommand('copy');
              area.remove();
              flash(copied ? tr('copied') : tr('copyFailed'));
              return copied;
            } catch {
              flash(tr('copyFailed'));
              return false;
            }
          }
        }, [flash, tr]);

        const quote = useCallback((text) => {
          let accepted = false;
          try {
            accepted = inputActions !== undefined
              && inputActions !== null
              && typeof inputActions.insertQuote === 'function'
              && inputActions.insertQuote(text) !== false;
          } catch {
            accepted = false;
          }
          if (accepted) {
            flash(tr('quoted'));
            remember(null);
          } else {
            void copy(text);
            flash(tr('quoteFailed'));
          }
        }, [copy, flash, inputActions, remember, tr]);

        const translate = useCallback((text, anchorOverride) => {
          const expected = translationTarget(text);
          const anchor = anchorOverride ?? targetRef.current ?? {
            x: window.innerWidth / 2,
            y: 120,
            bottom: 140,
          };
          translateAbort.current?.abort();
          const controller = new AbortController();
          translateAbort.current = controller;
          setCard({
            source: text,
            anchor,
            target: expected,
            loading: true,
            translation: '',
            error: '',
          });
          remember(null);
          void fetch('/file-agentero/translate', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-file-agentero': '1',
            },
            body: JSON.stringify({ text }),
            signal: controller.signal,
            cache: 'no-store',
          }).then(async (response) => {
            const body = await response.json().catch(() => null);
            if (!response.ok) {
              const message = body !== null && typeof body === 'object' && typeof body.error === 'string'
                ? body.error
                : tr('translateFailed');
              throw new Error(message);
            }
            const translation = body !== null && typeof body === 'object' && typeof body.translation === 'string'
              ? body.translation
              : '';
            if (translation.trim() === '') throw new Error(tr('translateFailed'));
            if (translateAbort.current !== controller) return;
            const actual = body !== null && typeof body === 'object' && typeof body.target === 'string'
              ? body.target
              : expected;
            setCard((current) => current === null ? null : {
              ...current,
              loading: false,
              translation,
              target: actual,
            });
          }).catch((error) => {
            if (controller.signal.aborted || translateAbort.current !== controller) return;
            const message = error instanceof Error && error.message.trim() !== ''
              ? error.message
              : tr('translateFailed');
            setCard((current) => current === null ? null : {
              ...current,
              loading: false,
              error: message,
            });
          });
        }, [remember, tr]);

        const headerButton = h(
          'div',
          { ref: rootRef, style: { display: 'contents' } },
          h(
            'button',
            {
              type: 'button',
              className: 'fa-head',
              'aria-pressed': follow,
              title: follow ? tr('followOn') : tr('followOff'),
              'aria-label': follow ? tr('followOn') : tr('followOff'),
              onClick: () => toggleFollow(!follow),
            },
            h(
              'svg',
              {
                width: 14,
                height: 14,
                viewBox: '0 0 16 16',
                fill: 'none',
                'aria-hidden': true,
              },
              h('circle', { cx: 8, cy: 8, r: 2.1, fill: 'currentColor' }),
              h('path', {
                d: 'M4.4 4.4a5.1 5.1 0 0 0 0 7.2M11.6 4.4a5.1 5.1 0 0 1 0 7.2',
                stroke: 'currentColor',
                strokeWidth: 1.3,
                strokeLinecap: 'round',
              }),
              follow
                ? null
                : h('path', {
                    d: 'M3 13 13 3',
                    stroke: 'currentColor',
                    strokeWidth: 1.4,
                    strokeLinecap: 'round',
                  }),
            ),
          ),
        );

        const place = (anchor) => {
          const below = anchor.y < 84;
          return {
            left: Math.max(96, Math.min(window.innerWidth - 96, anchor.x)),
            top: below ? anchor.bottom + 8 : anchor.y - 8,
            transform: below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
          };
        };

        const placeCard = (anchor) => {
          const width = Math.min(380, Math.max(220, window.innerWidth - 32));
          const left = Math.max(
            width / 2 + 16,
            Math.min(window.innerWidth - width / 2 - 16, anchor.x),
          );
          const above = anchor.y > 460;
          return {
            width,
            left,
            top: above
              ? anchor.y - 8
              : Math.max(16, Math.min(anchor.bottom + 8, window.innerHeight - 220)),
            transform: above ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
          };
        };

        const bar = target === null || card !== null
          ? null
          : createPortal(
              h(
                'div',
                {
                  className: 'fa-bar',
                  style: place(target),
                  role: 'toolbar',
                  'aria-label': tr('selection'),
                  onPointerDown: (event) => event.preventDefault(),
                },
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => void copy(target.text),
                  },
                  tr('copy'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => quote(target.text),
                  },
                  tr('quote'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => translate(target.text),
                  },
                  tr('translate'),
                ),
              ),
              document.body,
            );

        const toast = notice === null
          ? null
          : createPortal(
              h(
                'div',
                { className: 'fa-notice', style: place(notice) },
                notice.text,
              ),
              document.body,
            );

        const translatedCard = card === null
          ? null
          : createPortal(
              h(
                'div',
                { className: 'fa-card', style: placeCard(card.anchor), ref: cardRef },
                h(
                  'div',
                  { className: 'fa-card-head' },
                  h('span', { className: 'fa-card-title' }, tr('translateTitle')),
                  h(
                    'span',
                    { className: 'fa-card-dir' },
                    card.target === 'en' ? tr('zhToEn') : tr('enToZh'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'fa-card-close',
                      'aria-label': tr('close'),
                      title: tr('close'),
                      onClick: () => {
                        translateAbort.current?.abort();
                        setCard(null);
                      },
                    },
                    '×',
                  ),
                ),
                h(
                  'div',
                  { className: 'fa-card-body' },
                  card.loading
                    ? h('span', { className: 'fa-card-muted' }, tr('translating'))
                    : card.error !== ''
                      ? h('span', { className: 'fa-card-error' }, card.error)
                      : h('span', null, card.translation),
                ),
                card.loading
                  ? null
                  : h(
                      'div',
                      { className: 'fa-card-actions' },
                      card.error !== ''
                        ? h(
                            'button',
                            { type: 'button', onClick: () => translate(card.source, card.anchor) },
                            tr('retry'),
                          )
                        : null,
                      card.error === ''
                        ? h(
                            'button',
                            {
                              type: 'button',
                              onClick: () => {
                                targetRef.current = card.anchor;
                                void copy(card.translation);
                              },
                            },
                            tr('copyTranslation'),
                          )
                        : null,
                    ),
              ),
              document.body,
            );

        return h(React.Fragment, null, headerButton, bar, translatedCard, toast);
      };
    }

    // ---------------------------------------------------------------------
    // Follow edits: open the file the agent just changed in the right preview.
    // ---------------------------------------------------------------------

    function createFollowEdits(ctx) {
      function FollowEditsInner(props) {
        const { sessionId, useChat } = props;
        const [follow] = useFollow();
        const latest = useChat(selectLatestMutation);
        const seen = useRef('');
        const initialized = useRef(false);
        const timer = useRef(0);

        useEffect(() => {
          if (!initialized.current) {
            initialized.current = true;
            seen.current = latest;
            return undefined;
          }
          if (latest === seen.current) return undefined;
          seen.current = latest;
          if (latest === '' || latest === undefined || !follow) return undefined;

          const separator = latest.indexOf(EVENT_SEPARATOR);
          const path = separator === -1 ? latest : latest.slice(separator + 1);
          if (path === '' || !renderable(path)) return undefined;

          clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            try {
              ctx.sidebarRight.openResource(fileAddress(sessionId, path), {
                revealIfOpened: true,
              });
            } catch {
              // A path the preview cannot claim (outside the workspace, a
              // directory, a removed file) is not an error worth surfacing.
            }
          }, 350);
          return () => clearTimeout(timer.current);
        }, [latest, follow, sessionId]);

        useEffect(() => () => clearTimeout(timer.current), []);
        return null;
      }

      return function FollowEdits(props) {
        if (typeof props.useChat !== 'function') return null;
        return h(FollowEditsInner, props);
      };
    }

    // ---------------------------------------------------------------------
    // Settings → Plugins → this plugin's update page.
    // ---------------------------------------------------------------------

    function UpdateTab() {
      const tr = useCallback(translate, []);
      const [update, setUpdate] = useState(null);
      const [versions, setVersions] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const poll = useRef(0);

      const fetchJson = useCallback(async (url, init) => {
        const response = await fetch(url, {
          ...init,
          headers: { accept: 'application/json', ...(init?.headers ?? {}) },
          cache: 'no-store',
        });
        const body = await response.json().catch(() => null);
        if (!response.ok || body === null || typeof body !== 'object' || body.success === false) {
          const message = body !== null && typeof body === 'object' && typeof body.error === 'string'
            ? body.error
            : tr('updateLoadFailed');
          throw new Error(message);
        }
        return body;
      }, [tr]);

      const load = useCallback(async (fresh) => {
        const suffix = fresh ? '?fresh=1' : '';
        const nextUpdate = await fetchJson(`/file-agentero/update${suffix}`);
        setUpdate(nextUpdate);
        try {
          const nextVersions = await fetchJson(`/file-agentero/versions${suffix}`);
          setVersions(Array.isArray(nextVersions.versions) ? nextVersions.versions : []);
        } catch {
          setVersions((current) => current ?? []);
        }
        setError('');
      }, [fetchJson]);

      useEffect(() => {
        let alive = true;
        load(false).catch((cause) => {
          if (alive) {
            setError(cause instanceof Error && cause.message.trim() !== '' ? cause.message : tr('updateLoadFailed'));
          }
        });
        return () => {
          alive = false;
          clearInterval(poll.current);
          poll.current = 0;
        };
      }, [load, tr]);

      const check = useCallback(async () => {
        if (busy) return;
        setBusy(true);
        setError('');
        try {
          await load(true);
        } catch (cause) {
          setError(cause instanceof Error && cause.message.trim() !== '' ? cause.message : tr('updateLoadFailed'));
        } finally {
          setBusy(false);
        }
      }, [busy, load, tr]);

      const install = useCallback(async () => {
        if (update === null || update.available !== true || busy) return;
        setBusy(true);
        setError('');
        try {
          const body = await fetchJson('/file-agentero/update', {
            method: 'POST',
            headers: { 'x-file-agentero': '1' },
          });
          setUpdate(body);
          clearInterval(poll.current);
          let ticks = 0;
          poll.current = setInterval(async () => {
            ticks += 1;
            if (ticks > 80) {
              clearInterval(poll.current);
              poll.current = 0;
              setBusy(false);
              return;
            }
            try {
              const next = await fetchJson('/file-agentero/update?fresh=1');
              setUpdate(next);
              if (next.phase !== 'installing') {
                clearInterval(poll.current);
                poll.current = 0;
                setBusy(false);
                if (next.phase === 'installed') void load(true).catch(() => {});
              }
            } catch {
              // A transient poll failure keeps the last answer on screen.
            }
          }, 1500);
        } catch (cause) {
          setError(cause instanceof Error && cause.message.trim() !== '' ? cause.message : tr('updateFailed'));
          setBusy(false);
        }
      }, [busy, fetchJson, load, tr, update]);

      const phase = update?.phase ?? 'idle';
      const installing = phase === 'installing';
      const available = update !== null && update.available === true;
      const current = typeof update?.current === 'string' ? update.current : '';
      const latest = typeof update?.latest === 'string' ? update.latest : '';
      const modeText = update === null
        ? ''
        : update.mode === 'registry'
          ? tr('sourceRegistry')
          : update.mode === 'local'
            ? tr('sourceLocal')
            : update.mode === 'git'
              ? tr('sourceGit')
              : update.mode === 'tarball'
                ? tr('sourceTarball')
                : tr('sourceUnknown');
      const statusText = update === null
        ? tr('neverChecked')
        : update.mode === 'local'
          ? tr('sourceLocal')
          : update.mode === 'git'
            ? tr('sourceGit')
            : available
              ? `${tr('availableBadge')} v${latest}`
              : update.published === false
                ? tr('notPublished')
                : update.registryError
                  ? tr('checkFailed')
                  : phase === 'installed'
                    ? tr('updateInstalled')
                    : tr('upToDate');
      const checkedText = update !== null && typeof update.checkedAt === 'number' && update.checkedAt > 0
        ? `${tr('lastChecked')}${new Date(update.checkedAt).toLocaleString()}`
        : '';

      const row = (key, title, desc, control) => h(
        'div',
        { className: 'fa-set-row', key },
        h(
          'div',
          { className: 'fa-set-row-text' },
          h('span', { className: 'fa-set-row-title' }, title),
          desc === null || desc === '' ? null : h('span', { className: 'fa-set-row-desc' }, desc),
        ),
        control === null ? null : h('div', { className: 'fa-set-row-control' }, control),
      );

      const control = installing
        ? h('button', { type: 'button', className: 'fa-set-btn', disabled: true }, tr('updating'))
        : available
          ? h(
              'button',
              { type: 'button', className: 'fa-set-btn fa-set-btn--primary', onClick: install },
              `${tr('updateTo')} v${latest}`,
            )
          : h(
              'button',
              { type: 'button', className: 'fa-set-btn', onClick: check, disabled: busy },
              busy ? tr('checkingNow') : tr('checkNow'),
            );

      const list = versions ?? [];
      const history = versions === null
        ? h('div', { className: 'fa-set-empty' }, tr('checkingNow'))
        : list.length === 0
          ? h('div', { className: 'fa-set-empty' }, tr('noNotes'))
          : list.slice(0, 12).map((entry) => h(
              'div',
              {
                className: 'fa-set-version',
                key: entry.version,
                'data-current': update !== null && entry.version === update.current ? '1' : null,
              },
              h(
                'div',
                { className: 'fa-set-version-line' },
                h('span', { className: 'fa-set-version-no' }, `v${entry.version}`),
                typeof entry.date === 'string' && entry.date !== ''
                  ? h('span', { className: 'fa-set-version-date' }, entry.date.slice(0, 10))
                  : null,
                typeof entry.deprecated === 'string' && entry.deprecated !== ''
                  ? h('span', { className: 'fa-set-tag' }, entry.deprecated)
                  : null,
                update !== null && entry.version === update.current
                  ? h('span', { className: 'fa-set-tag' }, tr('currentTag'))
                  : null,
              ),
              Array.isArray(entry.notes) && entry.notes.length > 0
                ? h(
                    'ul',
                    { className: 'fa-set-notes' },
                    entry.notes.map((note, index) => h('li', { key: index }, note)),
                  )
                : h('div', { className: 'fa-set-empty' }, tr('noNotes')),
            ));

      const repoUrl = typeof update?.repoUrl === 'string' && update.repoUrl !== ''
        ? update.repoUrl
        : 'https://github.com/baobao1994/dsh-file-agentero';

      return h(
        'div',
        { className: 'fa-set' },
        h('h3', { className: 'fa-set-title' }, tr('updateTab')),
        h('p', { className: 'fa-set-intro' }, tr('updateIntro')),
        h(
          'div',
          { className: 'fa-set-rows' },
          row(
            'version',
            tr('rowVersion'),
            modeText,
            update === null
              ? h('span', { className: 'fa-set-empty' }, tr('neverChecked'))
              : h(
                  'span',
                  { className: 'fa-set-version-line' },
                  h('span', { className: 'fa-set-version-no' }, `v${current}`),
                  available ? h('span', { className: 'fa-set-badge' }, `${tr('availableBadge')} v${latest}`) : null,
                ),
          ),
          row(
            'update',
            tr('rowUpdate'),
            phase === 'failed'
              ? `${tr('updateFailed')}：${update?.error ?? ''}`
              : checkedText === '' ? statusText : `${statusText} · ${checkedText}`,
            control,
          ),
          phase === 'installed'
            ? row('installed', tr('rowUpdate'), tr('updateInstalled'), null)
            : null,
          row(
            'source',
            tr('rowSource'),
            modeText,
            h(
              'a',
              {
                className: 'fa-set-link',
                href: repoUrl,
                target: '_blank',
                rel: 'noreferrer noopener',
              },
              tr('repoLink'),
            ),
          ),
        ),
        error === '' ? null : h('div', { className: 'fa-set-error' }, error),
        h(
          'div',
          { className: 'fa-set-history' },
          h('h3', { className: 'fa-set-history-title' }, tr('versionHistory')),
          history,
        ),
      );
    }

    /**
     * The same update page, mounted on the plugin manager's bundle page.
     * The owner asks for a `summary` or a `page`; only the page renders a body.
     */
    function BundleConfig(props) {
      if (props?.view === 'summary') return translate('bundleSummary');
      return h(UpdateTab, {});
    }

    // ---------------------------------------------------------------------
    // Live draft: mirror the model's streaming write into a floating panel.
    // The file on disk is only written when the tool runs, so this reads the
    // tool call's partial arguments instead of the preview's file resource.
    // ---------------------------------------------------------------------

    function createLiveDraft() {
      function LiveDraftInner(props) {
        const { useChat } = props;
        const tr = useCallback(translate, []);
        const [selector] = useState(createLiveSelector);
        const liveKey = useChat(selector.select);
        const root = selector.current;
        const [dismissed, setDismissed] = useState('');
        const bodyRef = useRef(null);
        const stick = useRef(true);

        const name = root?.name || '';
        const callId = root?.callId || '';
        const args = root?.args;
        const path = args !== undefined && args !== null && typeof args.text === 'function'
          ? (args.text('file_path') ?? args.text('path') ?? '')
          : '';
        const write = name === 'write';
        const content = args !== undefined && args !== null && typeof args.text === 'function'
          ? (write
              ? (args.text('content') ?? '')
              : (args.text('new_string') ?? args.text('file_text') ?? args.text('content') ?? ''))
          : '';
        const oldText = !write && args !== undefined && args !== null && typeof args.text === 'function'
          ? (args.text('old_string') ?? args.text('old_str') ?? '')
          : '';
        const visible = liveKey !== '' && root !== null && callId !== '' && callId !== dismissed;

        useLayoutEffect(() => {
          const node = bodyRef.current;
          if (!visible || node === null || !stick.current) return;
          node.scrollTop = node.scrollHeight;
        }, [content, visible]);

        if (!visible) return null;

        const file = typeof path === 'string' && path !== ''
          ? (path.split(/[\\/]/).pop() || path)
          : tr('livePending');

        const onScroll = (event) => {
          const node = event.currentTarget;
          stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32;
        };

        return createPortal(
          h(
            'div',
            { className: 'fa-live', 'aria-label': write ? tr('liveWrite') : tr('liveEdit') },
            h(
              'div',
              { className: 'fa-live-head' },
              h('span', { className: 'fa-live-dot', 'aria-hidden': true }),
              h('span', { className: 'fa-live-title' }, write ? tr('liveWrite') : tr('liveEdit')),
              h('span', { className: 'fa-live-file', title: path || undefined }, file),
              h('span', { className: 'fa-live-count' }, String(content.length)),
              h(
                'button',
                {
                  type: 'button',
                  className: 'fa-live-close',
                  'aria-label': tr('liveClose'),
                  title: tr('liveClose'),
                  onClick: () => setDismissed(callId),
                },
                '×',
              ),
            ),
            h(
              'div',
              { className: 'fa-live-body', ref: bodyRef, onScroll },
              content === '' && (write || oldText === '')
                ? h('span', { className: 'fa-live-muted' }, tr('liveWaiting'))
                : write
                  ? h('pre', { className: 'fa-live-code' }, content)
                  : h(
                      'div',
                      { className: 'fa-live-diff' },
                      oldText !== ''
                        ? h('pre', { className: 'fa-live-old' }, `− ${oldText}`)
                        : null,
                      h('pre', { className: 'fa-live-new' }, `+ ${content}`),
                    ),
            ),
            h('div', { className: 'fa-live-foot' }, tr('liveHint')),
          ),
          document.body,
        );
      }

      return function LiveDraft(props) {
        if (typeof props.useChat !== 'function') return null;
        return h(LiveDraftInner, props);
      };
    }

    // ---------------------------------------------------------------------
    // Plugin entry.
    // ---------------------------------------------------------------------

    return {
      name: 'dsh-file-agentero',
      inject: ['slots', 'locale', 'sidebarRight'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }));
        ctx.effect(() => installStyles());

        const rememberLocale = (snapshot) => {
          const id = typeof snapshot === 'string' ? snapshot : snapshot?.active;
          if (typeof id === 'string' && id !== '') activeLocale = id;
        };
        try {
          rememberLocale(ctx.locale?.getSnapshot?.() ?? ctx.locale?.getLocale?.());
        } catch {
          // Keep the Chinese default; the page text still follows the slot locale.
        }
        ctx.effect(() => {
          try {
            const unsubscribe = ctx.locale?.subscribe?.((snapshot) => rememberLocale(snapshot));
            return typeof unsubscribe === 'function' ? unsubscribe : () => {};
          } catch {
            return () => {};
          }
        });

        // Version + update surface first, before any preview contribution: a
        // failure in a later seat must not take the update page down with it.
        ctx.effect(() => ctx.slots.inject('settings.plugins.tab', () =>
          ctx.slots.register(
            {
              name: 'settings.plugins.tab',
              id: 'file-agentero',
              // Before the plugin manager's own tabs, so a narrow tab bar never
              // pushes it into the overflow menu.
              order: 15,
              label: () => (activeLocale.toLowerCase().startsWith('zh')
                ? '版本更新'
                : 'Versions & updates'),
            },
            UpdateTab,
          ),
        ));

        ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            { name: 'plugins.bundle.config', key: 'dsh-file-agentero' },
            BundleConfig,
          ),
        ));

        ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document.actions', () =>
          ctx.slots.register(
            {
              name: 'sidebar.right.tab.document.actions',
              id: 'file-agentero-tools',
              order: 20,
              locale: NS,
            },
            createPreviewTools(ctx),
          ),
        ));

        ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: 'file-agentero-follow',
              order: 20,
            },
            createFollowEdits(ctx),
          ),
        ));

        ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: 'file-agentero-live',
              order: 21,
              locale: NS,
            },
            createLiveDraft(),
          ),
        ));
      },
    };
  },
});
