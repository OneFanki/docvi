/**
 * 设置归一化回归测试。
 *
 * 重点在迁移：设置是用户能直接手改的文件，旧版本写下去的形态必须还能读——
 * 读不出来会让应用要么退回默认主题，要么整体失效。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { normalizeSettings, DEFAULT_SETTINGS, TAB_WIDTH_MAX } =
  await import('../packages/shared/src/settings.ts')

test('空值 / 非对象回退默认设置', () => {
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS)
  assert.deepEqual(normalizeSettings('nope'), DEFAULT_SETTINGS)
  assert.deepEqual(normalizeSettings(42), DEFAULT_SETTINGS)
})

test('旧的三维主题对象迁移成单一主题 id，取 ui 作为种子', () => {
  const next = normalizeSettings({ theme: { ui: 'paper', doc: 'graphite', editor: 'paper' } })
  assert.equal(next.theme, 'paper')
})

test('三维主题对象里 ui 非法时回退默认，而不是留下对象', () => {
  assert.equal(normalizeSettings({ theme: { ui: '', doc: 'paper' } }).theme, DEFAULT_SETTINGS.theme)
  assert.equal(normalizeSettings({ theme: {} }).theme, DEFAULT_SETTINGS.theme)
})

test('已经是字符串的主题原样保留（含插件主题的运行时 id）', () => {
  assert.equal(normalizeSettings({ theme: 'plugin-base-ink' }).theme, 'plugin-base-ink')
})

test('旧键 fixedWidth 迁移成 maxWidth，语义从固定宽度改为上限', () => {
  const next = normalizeSettings({ tabs: { fixedWidth: 220 } })
  assert.equal(next.tabs.maxWidth, 220)
})

test('maxWidth 优先于旧键 fixedWidth', () => {
  const next = normalizeSettings({ tabs: { maxWidth: 260, fixedWidth: 180 } })
  assert.equal(next.tabs.maxWidth, 260)
})

test('标签宽度被夹到允许区间，非法值回退默认', () => {
  assert.equal(normalizeSettings({ tabs: { maxWidth: 9999 } }).tabs.maxWidth, TAB_WIDTH_MAX)
  assert.equal(normalizeSettings({ tabs: { maxWidth: 1 } }).tabs.maxWidth, 120)
  assert.equal(
    normalizeSettings({ tabs: { maxWidth: 'abc' } }).tabs.maxWidth,
    DEFAULT_SETTINGS.tabs.maxWidth,
  )
})

test('坏字段只丢弃自己，不拖垮其余设置', () => {
  const next = normalizeSettings({
    theme: 'paper',
    locale: 'en',
    tabs: { maxWidth: 'abc', layout: 'wrap' },
    sidebarCollapsed: true,
  })
  assert.equal(next.theme, 'paper')
  assert.equal(next.locale, 'en')
  assert.equal(next.tabs.layout, 'wrap')
  assert.equal(next.tabs.maxWidth, DEFAULT_SETTINGS.tabs.maxWidth)
  assert.equal(next.sidebarCollapsed, true)
})

test('未知 locale 回退中文，布尔项只认 true/false', () => {
  assert.equal(normalizeSettings({ locale: 'fr' }).locale, 'zh')
  assert.equal(normalizeSettings({ sidebarCollapsed: 'yes' }).sidebarCollapsed, false)
  // 非布尔值不算数，回该项的默认值（托盘默认是开）
  assert.equal(normalizeSettings({ desktop: { closeToTray: 1 } }).desktop.closeToTray, true)
  assert.equal(normalizeSettings({ desktop: { closeToTray: 0 } }).desktop.closeToTray, true)
})

test('关闭窗口留托盘默认开启，且缺字段时不会被归一化成关闭', () => {
  assert.equal(DEFAULT_SETTINGS.desktop.closeToTray, true)
  assert.equal(normalizeSettings({}).desktop.closeToTray, true)
  assert.equal(normalizeSettings({ desktop: {} }).desktop.closeToTray, true)
  assert.equal(normalizeSettings({ desktop: { closeToTray: false } }).desktop.closeToTray, false)
  // 类型不对时回默认值，而不是静默变成关闭
  assert.equal(normalizeSettings({ desktop: { closeToTray: 'yes' } }).desktop.closeToTray, true)
})

test('源码折行默认开启，非法值回退默认', () => {
  // 默认折行：文档不是代码，横向滚动会让人左右找丢失的行首
  assert.equal(DEFAULT_SETTINGS.editorWrap, 'wrap')
  assert.equal(normalizeSettings({}).editorWrap, 'wrap')
  assert.equal(normalizeSettings({ editorWrap: 'nowrap' }).editorWrap, 'nowrap')
  assert.equal(normalizeSettings({ editorWrap: 'wrap' }).editorWrap, 'wrap')
  // 手改成任意字符串只丢弃这一项
  assert.equal(normalizeSettings({ editorWrap: 'auto' }).editorWrap, 'wrap')
  assert.equal(normalizeSettings({ editorWrap: 1 }).editorWrap, 'wrap')
})
