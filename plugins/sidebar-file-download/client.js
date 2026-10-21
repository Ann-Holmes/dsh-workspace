/**
 * Browser half: download controls for the file open in the right Sidebar.
 *
 * The file tree's rows have no per-row action seat, so the gesture lives where
 * the file itself is shown: the preview header's
 * `sidebar.right.tab.document.actions` list, and the unsupported-preview empty
 * state's `sidebar.right.tab.document.unpreviewable` list under the same id.
 * Both receive `absolutePath` from the preview and the Session-scoped
 * `sessionId`, so the read is the ordinary `workspaceFiles.readBytes` call the
 * shipped renderers already use.
 *
 * Bytes are read complete when the Host's complete-file cap allows it, and in
 * byte windows otherwise, then handed to the browser's download manager as a
 * Blob. Nothing is persisted, and no Host half is needed.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-sidebar-file-download',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Copy namespace; the slot's `locale` option binds it to the `t` prop. */
    const NS = 'sidebarFileDownload'
    /** One chunked read window; a Host with a lower `maxBytes` answers with its cap and is retried. */
    const WINDOW_BYTES = 2 * 1024 * 1024
    /**
     * Ceiling for one browser download. The bytes are held in the page until the
     * download manager takes them, so a file above this is refused with its
     * limit instead of risking the tab's memory.
     */
    const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024
    /** How long a failure banner stays before it withdraws itself. */
    const TOAST_MS = 6000
    /** Blob URL lifetime: long enough for the browser's download manager to consume it. */
    const REVOKE_MS = 5 * 60 * 1000

    const zh = {
      'action.download': '下载文件',
      'action.downloading': '正在下载…',
      'action.downloadingPercent': '正在下载 {percent}%',
      'action.dismiss': '关闭提示',
      'error.notFound': '文件不存在，可能已被移动或删除。',
      'error.notRegular': '这不是一个普通文件，无法下载。',
      'error.outsideWorkspace': '这个路径在工作区之外，无法下载。',
      'error.tooLarge': '文件超出了读取上限，无法下载。',
      'error.overLimit': '文件超过 {limit}，浏览器无法下载。',
      'error.changed': '下载途中文件被修改了，请重新下载。',
      'error.unreadable': '文件内容无法读取。',
      'error.cancelled': '下载已取消。',
      'error.generic': '下载失败，请重试。',
      'error.withReason': '下载失败：{reason}',
    }

    const en = {
      'action.download': 'Download file',
      'action.downloading': 'Downloading…',
      'action.downloadingPercent': 'Downloading {percent}%',
      'action.dismiss': 'Dismiss',
      'error.notFound': 'That file is gone. It may have been moved or deleted.',
      'error.notRegular': 'That path is not a regular file, so it cannot be downloaded.',
      'error.outsideWorkspace': 'That path is outside the workspace, so it cannot be downloaded.',
      'error.tooLarge': 'That file exceeds the read limit, so it cannot be downloaded.',
      'error.overLimit': 'That file is larger than {limit}, so the browser cannot download it.',
      'error.changed': 'The file changed while it was downloading. Download it again.',
      'error.unreadable': 'That file cannot be read.',
      'error.cancelled': 'The download was cancelled.',
      'error.generic': 'The download failed. Try again.',
      'error.withReason': 'The download failed: {reason}',
    }

    // The document header's own 28px round control row is the model: same
    // geometry, a 15px glyph, and the neighbouring host control's tokens. The
    // unsupported-preview variant is the host's 36px labeled action.
    const CSS = `
.dsh-fd__tool {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 6px;
  color: var(--dsw-alias-label-secondary);
  line-height: 1;
  background: transparent;
  border: none;
  border-radius: var(--dsw-radius-sm);
  cursor: pointer;
}
.dsh-fd__tool:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-fd__tool:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.dsh-fd__tool:disabled {
  cursor: default;
}
.dsh-fd__tool svg {
  display: block;
  width: 15px;
  height: 15px;
}
.dsh-fd__tool[data-state='busy'] svg {
  animation: dsh-fd-pulse 1s ease-in-out infinite;
}
.dsh-fd__spinner {
  display: block;
  width: 13px;
  height: 13px;
  border: 1.5px solid var(--dsw-alias-label-secondary);
  border-top-color: transparent;
  border-radius: 50%;
  animation: dsh-fd-spin 0.8s linear infinite;
}
.dsh-fd__button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  box-sizing: border-box;
  height: 36px;
  padding: 6px 14px;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 14px;
  line-height: 20px;
  background: transparent;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  cursor: pointer;
}
.dsh-fd__button:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-fd__button:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.dsh-fd__button:disabled {
  cursor: default;
  opacity: 0.65;
}
.dsh-fd__button svg {
  display: block;
  width: 16px;
  height: 16px;
}
.dsh-fd__toast {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 100;
  display: flex;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  max-width: min(360px, calc(100vw - 32px));
  padding: 8px 10px;
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family);
  font-size: 12px;
  line-height: 18px;
  background: var(--dsw-alias-bg-overlay);
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
}
.dsh-fd__toastIcon {
  display: inline-flex;
  flex: none;
  color: var(--dsw-alias-state-error-primary);
}
.dsh-fd__toastIcon svg {
  display: block;
  width: 14px;
  height: 14px;
}
.dsh-fd__toastText {
  flex: 1 1 auto;
  min-width: 0;
}
.dsh-fd__toastClose {
  flex: none;
  width: 20px;
  height: 20px;
  padding: 0;
  color: var(--dsw-alias-label-secondary);
  font-family: inherit;
  font-size: 14px;
  line-height: 1;
  background: transparent;
  border: none;
  border-radius: var(--dsw-radius-sm);
  cursor: pointer;
}
.dsh-fd__toastClose:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
@keyframes dsh-fd-spin {
  to { transform: rotate(360deg); }
}
@keyframes dsh-fd-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-fd__spinner { animation: none; border-top-color: var(--dsw-alias-label-secondary); opacity: 0.6; }
  .dsh-fd__tool[data-state='busy'] svg { animation: none; opacity: 0.6; }
}
`

    /** The download glyph: an arrow into a tray, drawn in the adjacent controls' 15px cell. */
    function DownloadGlyph() {
      return h('svg', {
        viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: 'false',
      },
      h('path', { d: 'M8 2.6v6.6' }),
      h('path', { d: 'M5.4 6.9 8 9.5l2.6-2.6' }),
      h('path', { d: 'M3.2 11.6v1.1c0 .3.2.5.5.5h8.6c.3 0 .5-.2.5-.5v-1.1' }))
    }

    /** The failure banner's warning glyph. */
    function WarningGlyph() {
      return h('svg', {
        viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: 'false',
      },
      h('path', { d: 'M8 2.4 14.2 13H1.8L8 2.4Z' }),
      h('path', { d: 'M8 6.2v3.1' }),
      h('path', { d: 'M8 11.4v.1' }))
    }

    /** The downloaded file's own name, taken from the absolute path the preview hands over. */
    function fileNameOf(path) {
      const segments = String(path).split(/[\\/]+/).filter(segment => segment.length > 0)
      return segments.length === 0 ? 'download' : segments[segments.length - 1]
    }

    /** Accept the codec's native bytes whatever view type reaches this closure. */
    function toBytes(data) {
      if (data instanceof Uint8Array) return data
      if (data instanceof ArrayBuffer) return new Uint8Array(data)
      if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      throw new Error('workspaceFiles.readBytes returned no bytes')
    }

    /** Join the read windows into one buffer for the Blob. */
    function concatBytes(chunks, total) {
      if (chunks.length === 1) return chunks[0]
      const joined = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        joined.set(chunk, offset)
        offset += chunk.byteLength
      }
      return joined
    }

    /** One size written for people: whole mebibytes, or the exact size below one. */
    function sizeText(bytes) {
      if (bytes < 1024 * 1024) return `${bytes} B`
      return `${Math.round(bytes / 1024 / 1024)} MB`
    }

    /** A refusal for a file this control will not pull through the page. */
    function overLimit(size) {
      const failure = new Error(`file is ${size} bytes, above the ${MAX_DOWNLOAD_BYTES} byte browser download limit`)
      failure.code = 'download/over-limit'
      failure.size = size
      return failure
    }

    /** The file was rewritten between two windows, so the joined bytes would mix versions. */
    function changedWhileReading() {
      const failure = new Error('the file version changed between reads')
      failure.code = 'download/changed'
      return failure
    }

    /**
     * Read the whole file: one complete read when the Host's complete-file cap
     * allows it, byte windows otherwise (a file above that cap is not refused;
     * it is read window by window). The metadata read that precedes the bytes
     * also decides the browser-memory ceiling, and a window whose version
     * differs from the first one ends the read instead of joining two versions.
     * @param remote - the injected Client Remote face.
     * @param sessionId - Session whose filesystem authorizes the read.
     * @param path - absolute path handed over by the preview.
     * @param signal - cancels the read when the control unmounts.
     * @param report - receives the completed fraction, or null when the size is unknown.
     */
    async function readAllBytes(remote, sessionId, path, signal, report) {
      const meta = await remote.workspaceFiles.stat(sessionId, path, signal)
      if (!meta.ok) throw meta.error
      let total = meta.value.bytes
      if (typeof total === 'number' && total > MAX_DOWNLOAD_BYTES) throw overLimit(total)
      const whole = await remote.workspaceFiles.readBytes(sessionId, path, {}, signal)
      if (whole.ok) {
        report(1)
        return toBytes(whole.value.data)
      }
      if (whole.error === undefined || whole.error.code !== 'workspace-file/too-large') throw whole.error
      let length = WINDOW_BYTES
      let offset = 0
      let version = meta.value.version
      const chunks = []
      for (;;) {
        const page = await remote.workspaceFiles.readBytes(sessionId, path, { range: { offset, length } }, signal)
        if (!page.ok) {
          const failure = page.error
          if (failure !== undefined && failure.code === 'workspace-file/too-large') {
            const limit = failure.details === undefined ? Number.NaN : Number(failure.details.limit)
            const next = Number.isFinite(limit) && limit > 0 && limit < length ? limit : Math.floor(length / 2)
            if (next >= 1 && next < length) {
              length = next
              continue
            }
          }
          throw failure
        }
        const value = page.value
        if (value.version !== version) throw changedWhileReading()
        if (typeof value.bytes === 'number') total = value.bytes
        const data = toBytes(value.data)
        chunks.push(data)
        offset += data.byteLength
        if (offset > MAX_DOWNLOAD_BYTES) throw overLimit(offset)
        report(total === undefined || total <= 0 ? null : Math.min(1, offset / total))
        if (value.eof === true || data.byteLength === 0) break
        if (signal.aborted) throw new Error('aborted')
      }
      return concatBytes(chunks, offset)
    }

    /** Hand bytes to the browser's download manager under the file's own name. */
    function saveBytes(bytes, fileName) {
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = fileName
      anchor.rel = 'noopener'
      try {
        anchor.click()
      } finally {
        window.setTimeout(() => { URL.revokeObjectURL(url) }, REVOKE_MS)
      }
    }

    /** The localized sentence for one failed download. */
    function failureText(cause, t) {
      const code = cause !== null && typeof cause === 'object' ? cause.code : undefined
      switch (code) {
        case 'workspace-file/not-found': return t('error.notFound')
        case 'workspace-file/not-regular-file': return t('error.notRegular')
        case 'workspace-file/outside-workspace': return t('error.outsideWorkspace')
        case 'workspace-file/too-large': return t('error.tooLarge')
        case 'workspace-file/not-text': return t('error.unreadable')
        case 'gateway/cancelled': return t('error.cancelled')
        case 'download/over-limit': return t('error.overLimit', {
          limit: sizeText(typeof cause.size === 'number' ? cause.size : MAX_DOWNLOAD_BYTES),
        })
        case 'download/changed': return t('error.changed')
        default: {
          const reason = cause instanceof Error && cause.message !== '' ? cause.message : ''
          return reason === '' ? t('error.generic') : t('error.withReason', { reason })
        }
      }
    }

    /** The control's accessible name and tooltip, carrying chunked-read progress. */
    function actionLabel(t, status, progress) {
      if (status !== 'busy') return t('action.download')
      if (progress === null || progress >= 1) return t('action.downloading')
      return t('action.downloadingPercent', { percent: Math.round(progress * 100) })
    }

    /** The component-local stylesheet; unmounting removes it with the rest of the subtree. */
    function StyleSheet() {
      return h('style', { 'data-dsh-file-download-style': '' }, CSS)
    }

    /** The transient failure banner, announced once per failed gesture. */
    function FailureToast(props) {
      const { text, dismiss, t } = props
      return h('div', { className: 'dsh-fd__toast', role: 'status', 'aria-live': 'polite' },
        h('span', { className: 'dsh-fd__toastIcon', 'aria-hidden': true }, h(WarningGlyph)),
        h('span', { className: 'dsh-fd__toastText' }, text),
        h('button', {
          type: 'button', className: 'dsh-fd__toastClose', 'aria-label': t('action.dismiss'),
          title: t('action.dismiss'), onClick: dismiss,
        }, '\u00d7'))
    }

    /**
     * The plugin body: dictionaries, the download gesture, and the two slot
     * entries that host it. Both registrations wait for the preview entry that
     * declares their slot through `ctx.slots.inject`.
     */
    return {
      inject: ['slots', 'locale', 'remote', 'remote.workspaceFiles'],
      apply(ctx) {
        const remote = ctx.remote
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'file-download: dictionaries')

        /** The slot's locale-bound translate function, with a key-passthrough fallback. */
        function translateOf(props) {
          return typeof props.t === 'function' ? props.t : key => key
        }

        /** One control's download state machine, owned by the control that started it. */
        function useDownloader(props, t) {
          const { sessionId, absolutePath } = props
          const [status, setStatus] = React.useState('idle')
          const [progress, setProgress] = React.useState(null)
          const [failure, setFailure] = React.useState(null)
          const [attempt, setAttempt] = React.useState(0)
          const controllerRef = React.useRef(null)
          const aliveRef = React.useRef(true)

          React.useEffect(() => () => {
            aliveRef.current = false
            const controller = controllerRef.current
            controllerRef.current = null
            if (controller !== null) controller.abort()
          }, [])

          React.useEffect(() => {
            if (failure === null) return undefined
            const timer = window.setTimeout(() => {
              if (aliveRef.current) setFailure(null)
            }, TOAST_MS)
            return () => { window.clearTimeout(timer) }
          }, [failure, attempt])

          const start = React.useCallback(() => {
            if (controllerRef.current !== null) return
            if (typeof sessionId !== 'string' || typeof absolutePath !== 'string') {
              setFailure(t('error.generic'))
              setAttempt(value => value + 1)
              return
            }
            const controller = new AbortController()
            controllerRef.current = controller
            setStatus('busy')
            setProgress(null)
            setFailure(null)
            const run = async () => {
              try {
                const bytes = await readAllBytes(remote, sessionId, absolutePath, controller.signal, (ratio) => {
                  if (aliveRef.current) setProgress(ratio)
                })
                if (!aliveRef.current) return
                saveBytes(bytes, fileNameOf(absolutePath))
              } catch (cause) {
                if (!aliveRef.current || controller.signal.aborted) return
                setFailure(failureText(cause, t))
                setAttempt(value => value + 1)
              } finally {
                if (controllerRef.current === controller) controllerRef.current = null
                if (aliveRef.current) setStatus('idle')
              }
            }
            void run()
          }, [absolutePath, sessionId, t])

          return {
            status,
            progress,
            failure,
            start,
            dismiss: React.useCallback(() => { setFailure(null) }, []),
          }
        }

        /** Header contribution: a round icon control beside the preview's own controls. */
        function HeaderDownloadButton(props) {
          const t = translateOf(props)
          const { status, progress, failure, start, dismiss } = useDownloader(props, t)
          const label = actionLabel(t, status, progress)
          return h(React.Fragment, null,
            h(StyleSheet),
            h('button', {
              type: 'button',
              className: 'dsh-fd__tool',
              'data-dsh-file-download': 'header',
              'data-state': status,
              title: label,
              'aria-label': label,
              'aria-busy': status === 'busy' ? 'true' : undefined,
              disabled: status === 'busy',
              onClick: start,
            }, status === 'busy' ? h('span', { className: 'dsh-fd__spinner', 'aria-hidden': true }) : h(DownloadGlyph)),
            failure === null ? null : h(FailureToast, { text: failure, dismiss, t }))
        }

        /** Unsupported-preview contribution: the host's labeled action in the empty state. */
        function EmptyDownloadButton(props) {
          const t = translateOf(props)
          const { status, progress, failure, start, dismiss } = useDownloader(props, t)
          const label = actionLabel(t, status, progress)
          const text = status === 'busy' && progress !== null && progress < 1
            ? t('action.downloadingPercent', { percent: Math.round(progress * 100) })
            : status === 'busy' ? t('action.downloading') : t('action.download')
          return h(React.Fragment, null,
            h(StyleSheet),
            h('button', {
              type: 'button',
              className: 'dsh-fd__button',
              'data-dsh-file-download': 'empty',
              'data-state': status,
              title: label,
              'aria-busy': status === 'busy' ? 'true' : undefined,
              disabled: status === 'busy',
              onClick: start,
            }, status === 'busy' ? h('span', { className: 'dsh-fd__spinner', 'aria-hidden': true }) : h(DownloadGlyph),
            h('span', null, text)),
            failure === null ? null : h(FailureToast, { text: failure, dismiss, t }))
        }

        ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({
          name: 'sidebar.right.tab.document.actions',
          id: 'file-download',
          order: 10,
          locale: NS,
        }, HeaderDownloadButton)), 'file-download: header action')

        ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document.unpreviewable', () => ctx.slots.register({
          name: 'sidebar.right.tab.document.unpreviewable',
          id: 'file-download',
          order: 10,
          locale: NS,
        }, EmptyDownloadButton)), 'file-download: empty action')
      },
    }
  },
})
