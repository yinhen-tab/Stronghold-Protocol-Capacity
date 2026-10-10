// Opt-in local asset management. Downloading and import are byte-level operations; game rendering keeps
// its existing memory budgets. Closing this dialog leaves an explicit background task running.
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, Modal, confirmDialog } from './components.js';
import { assetCache } from '../assetCache.js';
import { store, selectRoute } from '../store.js';
import { t } from '../../../shared/i18n.js';

const viewers = new Set();
let opened = false;
const show = (value) => { opened = value; for (const fn of viewers) fn(value); };
const active = (phase) => ['initializing', 'checking', 'verifying', 'downloading', 'importing'].includes(phase);

export function formatCacheBytes(bytes = 0) {
  const n = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  return `${(n / 1048576).toFixed(1)} MiB`;
}

export function formatCacheRate(bytes = 0) {
  const n = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  return n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : formatCacheBytes(n);
}

function useAssetCache() {
  const [state, setState] = useState(() => assetCache.getState());
  useEffect(() => assetCache.subscribe(() => setState(assetCache.getState())), []);
  return state;
}

export function AssetCacheButton({ compact = false }) {
  const state = useAssetCache();
  return html`<${Button} variant="primary" size="sm" icon="download" class="asset-cache-entry"
      title=${t('素材预缓存')} aria-label=${t('素材预缓存')} data-testid="asset-cache-open"
      onClick=${() => { show(true); assetCache.initialize().catch(() => {}); }}>
    <span class=${compact ? 'asset-cache-entry__compact' : 'asset-cache-entry__label'}>${t('预缓存')}</span>
    ${active(state.phase) ? html`<i class="asset-cache-entry__busy" aria-hidden="true"></i>` : null}<//>`;
}

export function cacheErrorText(code) {
  switch (code) {
    case 'ASSET_CACHE_UNSUPPORTED':
    case 'ASSET_CACHE_HTTPS_REQUIRED': return t('预缓存需要 HTTPS 或 localhost，以及支持站点存储的浏览器。');
    case 'ASSET_CACHE_CATALOG_UNAVAILABLE': return t('素材清单加载失败，请检查连接后重试。');
    case 'ASSET_CACHE_BAD_CATALOG': return t('服务器素材清单无效，暂时无法预缓存。');
    case 'ASSET_CACHE_QUOTA': return t('浏览器存储空间不足。已缓存文件保留，可释放空间后继续。');
    case 'ASSET_CACHE_HASH_MISMATCH': return t('部分文件校验失败，未写入缓存。请重新导入或下载缺项。');
    case 'ASSET_CACHE_ZIP_INVALID':
    case 'ASSET_CACHE_ZIP_UNSAFE':
    case 'ASSET_CACHE_ZIP_TOO_LARGE':
    case 'ASSET_CACHE_FILE_TOO_LARGE': return t('无法读取素材包，请选择本站提供的 ZIP 素材包。');
    case 'ASSET_CACHE_ONLINE_DISABLED': return t('服主已关闭在线补齐，请使用本地素材包导入。');
    case 'ASSET_CACHE_STALE_CATALOG': return t('服务器素材已更新，请重新检查后继续补齐。');
    case 'ASSET_CACHE_BUSY': return t('另一个页面正在管理素材缓存，请稍后重试。');
    case 'ASSET_CACHE_PLAYING': return t('对局期间暂停批量缓存，返回大厅后可继续。');
    case 'ASSET_CACHE_DOWNLOAD_FAILED': return t('下载中断，已完成文件保留，请稍后继续。');
    default: return t('缓存操作失败，已完成文件保留，请重试。');
  }
}

function phaseText(phase) {
  switch (phase) {
    case 'initializing':
    case 'checking':
    case 'verifying': return t('正在检查缓存');
    case 'importing': return t('正在导入本地包');
    case 'downloading': return t('正在补齐缺项');
    case 'paused': return t('已暂停，可继续');
    case 'ready': return t('当前素材已缓存完整');
    case 'error': return t('操作未完成');
    default: return t('准备就绪');
  }
}

function persistenceText(state) {
  if (state.storage?.persisted) return t('浏览器已允许持久保存');
  switch (state.persistence) {
    case 'requesting': return t('正在申请持久保存…');
    case 'denied': return t('浏览器本次未授予持久保存，现有缓存仍可使用；今后可再次申请。');
    case 'error': return t('持久保存申请失败，请检查浏览器的站点存储设置后重试。');
    default: return state.storage?.persistenceSupported
      ? t('浏览器尚未允许持久保存，空间不足时可能清理缓存')
      : t('当前浏览器不支持申请持久保存，现有缓存仍可使用。');
  }
}

export function AssetCacheHost() {
  const [open, setOpen] = useState(opened);
  const state = useAssetCache();
  const input = useRef(null);
  useEffect(() => { viewers.add(setOpen); return () => viewers.delete(setOpen); }, []);
  if (!open) return null;
  const busy = active(state.phase);
  const disabled = busy || !state.supported || state.playing;
  const ready = state.readyFiles || 0, total = state.totalFiles || 0;
  const percent = total ? Math.min(100, 100 * ready / total) : 0;
  const run = (fn) => Promise.resolve().then(fn).catch(() => {});
  const storage = state.storage;
  const error = typeof state.error === 'string' ? state.error : state.error?.code;
  const chooseFile = () => input.current?.click();
  const importFile = (event) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (file) run(() => assetCache.importZip(file));
  };
  const clear = async () => {
    const yes = await confirmDialog({ title: t('清理素材缓存'),
      text: t('清理后游戏需要重新读取服务器素材或再次导入。此操作不影响身份、设置和本机战绩。'), danger: true });
    if (yes) await assetCache.clear();
  };
  return html`<${Modal} open=${true} title=${t('素材预缓存')} micro="ASSET CACHE" class="asset-cache-dialog"
      width="min(7.8rem, 94vw)" onClose=${() => show(false)}
      actions=${html`<${Button} variant="secondary" onClick=${() => show(false)}>${t('关闭')}<//>`}>
    <div class="asset-cache">
      <p class="asset-cache__intro">${t('优先导入完整素材包，素材只在本机解压和保存，不上传服务器。在线补齐只下载缺失或更新的文件。')}</p>
      <div class="asset-cache__summary" aria-live="polite">
        <strong>${phaseText(state.phase)}</strong>
        <span class="num">${t('已缓存 {ready} / {total} 个文件', { ready, total })}</span>
        <span>${t('已保存 {ready} / {total}', { ready: formatCacheBytes(state.readyBytes), total: formatCacheBytes(state.totalBytes) })}</span>
      </div>
      <progress class="asset-cache__progress" max="100" value=${percent} aria-label=${t('缓存进度')}></progress>
      <div class="asset-cache__details">
        <span>${t('仍需补齐 {n} 个文件，约 {size}', { n: state.missingFiles || 0, size: formatCacheBytes(state.missingBytes) })}</span>
        ${state.phase === 'downloading' ? html`<span>${t('当前下载速度：{speed}/s', { speed: formatCacheRate(state.speedBps) })}</span>` : null}
        ${state.importStats ? html`<span>${t('本次导入：新增 {added}，复用 {reused}，不适用 {skipped}，失败 {invalid}', {
          added: state.importStats.imported, reused: state.importStats.reused,
          skipped: state.importStats.unknown, invalid: state.importStats.invalid,
        })}</span>` : null}
      </div>
      ${state.playing ? html`<p class="asset-cache__warning" role="status">${t('对局期间暂停批量缓存，返回大厅后可继续。')}</p>` : null}
      ${state.version && state.catalogComplete === false ? html`<p class="asset-cache__warning">${t('服务器素材存在缺项，只能缓存当前可用文件，请联系服主补齐。')}</p>` : null}
      ${!state.supported ? html`<p class="asset-cache__warning">${cacheErrorText('ASSET_CACHE_UNSUPPORTED')}</p>` : null}
      ${error && state.supported ? html`<p class="asset-cache__warning" role="alert">${cacheErrorText(error)}</p>` : null}
      <input ref=${input} type="file" accept=".zip,application/zip" class="asset-cache__file" onChange=${importFile} tabindex="-1" />
      <div class="asset-cache__actions">
        <${Button} variant="primary" icon="folder" disabled=${disabled} onClick=${chooseFile} data-testid="asset-cache-import">
          ${t('导入本地素材包')}<span class="asset-cache__recommend">${t('强烈推荐')}</span><//>
        <${Button} variant="secondary" icon="download" disabled=${disabled || !state.missingFiles || state.policy?.enabled === false}
            onClick=${() => run(() => assetCache.downloadMissing())} data-testid="asset-cache-download">${t('在线补齐缺项')}<//>
        ${busy ? html`<${Button} variant="secondary" onClick=${() => assetCache.pause()} data-testid="asset-cache-pause">${t('暂停')}<//>` : null}
      </div>
      <p class="asset-cache__warning">${t('从服务器直接下载所有资源非常缓慢，推荐从公告中提供的素材包下载方式中下载')}</p>
      <div class="asset-cache__checks">
        <${Button} variant="secondary" size="sm" disabled=${disabled} onClick=${() => run(() => assetCache.scan({ deep: false }))}>${t('检查更新与缺项')}<//>
        <${Button} variant="secondary" size="sm" disabled=${disabled} onClick=${() => run(() => assetCache.scan({ deep: true }))} data-testid="asset-cache-verify">${t('完整校验')}<//>
        <${Button} variant="secondary" size="sm" disabled=${disabled} onClick=${() => run(clear)}>${t('清理素材缓存')}<//>
      </div>
      <div class="asset-cache__storage">
        ${storage ? html`<span>${t('本站存储：已用 {used} / 配额约 {quota}', { used: formatCacheBytes(storage.usage), quota: formatCacheBytes(storage.quota) })}</span>` : null}
        <span role="status" data-testid="asset-cache-persistence-status">${persistenceText(state)}</span>
        <${Button} variant="secondary" size="sm" loading=${state.persistence === 'requesting'}
            disabled=${disabled || storage?.persisted || !storage?.persistenceSupported}
            onClick=${() => assetCache.requestPersistence()} data-testid="asset-cache-persist">${t('申请持久保存')}<//>
        <p class="asset-cache__note">${t('持久保存可防止浏览器在空间不足时自动清理本站数据；是否授予由浏览器决定，通常不会弹出提示。主动清理站点数据仍会删除缓存。')}</p>
      </div>
      <p class="asset-cache__note">${t('缓存属于当前浏览器和网站地址。清理站点数据会删除缓存；新版本只需补齐变化文件。完整校验会读取本地文件，不重新下载全部素材。')}</p>
      <p class="asset-cache__note">${t('在线补齐共享服务器限速，进入对局后自动暂停。关闭此窗口可继续当前任务；关闭页面后已完成文件保留。')}</p>
    </div>
  <//>`;
}

/** Register without delaying login; stop optional filling as soon as the app enters a match. */
export function installAssetCache() {
  const follow = () => assetCache.setPlaying(selectRoute(store.get()) === 'game');
  follow(); store.subscribe(follow);
  assetCache.initialize().catch(() => {});
}
