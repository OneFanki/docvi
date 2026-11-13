/**
 * 界面文案的「非功能信息」门禁。
 *
 * 界面上反复出现实现理由（为什么选某个字体、进程怎么复用、配置文件在哪），
 * 用户看到的是开发者的思考过程，不是他能用的信息。这类文案的共同特征是
 * 出现了**用户不需要的技术专名**：内部实现名、选型理由、文件路径。
 *
 * 这里只挡最容易泛滥的一类——实现理由与内部路径。至于「这条提示到底该不该
 * 有」是判断题，机器判不了，靠 docs/engineering/界面文案规范.md 里的自检。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const I18N = readFileSync(
  new URL('../apps/desktop/src/renderer/src/lib/i18n.ts', import.meta.url),
  'utf8',
)

/**
 * 取出指定前缀的全部文案值（中英各一份）。
 * 只扫 `'key': 'value'` 与 `'key':\n    'value'` 两种书写形式。
 */
function valuesOf(prefix) {
  const out = []
  const re = new RegExp(`'${prefix}[\\w.]*':\\s*\\n?\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'g')
  let match
  while ((match = re.exec(I18N))) out.push(match[1])
  return out
}

test('设置页不解释字体选型理由', () => {
  // 「鸿蒙没有等宽的公开版本」「固定用 JetBrains Mono」——这是为什么这么实现，
  // 属于代码注释。用户只需要看到字体选项本身。
  const hints = valuesOf('settings.font')
  for (const text of hints) {
    assert.doesNotMatch(
      text,
      /JetBrains|等宽版本|monospace|没有公开/i,
      `字体说明泄漏了实现理由：${text}`,
    )
  }
})

test('设置页不复述主题机制', () => {
  // 「一个主题就是整套配色」「插件也可以提供主题」——主题卡片的预览已经说明了
  assert.equal(valuesOf('theme.lead').length, 0, 'theme.lead 属于复述控件，应删除')
  assert.equal(valuesOf('settings.themeHint').length, 0, 'settings.themeHint 属于复述控件，应删除')
})

test('设置页不列 MCP 工具清单', () => {
  // 八个工具名是 API 文档的内容，设置页只需要指路
  assert.equal(valuesOf('settings.toolsHint').length, 0, '工具清单不属于界面')
  for (const text of valuesOf('settings.mcpHint')) {
    assert.doesNotMatch(text, /list_plugins|write_doc|get_component_docs/, '设置页不应枚举工具名')
  }
})

test('界面不暴露配置文件的内部路径', () => {
  // 「设置保存在 userData/settings.json」——用户既看不到也不需要这个路径
  for (const text of [...valuesOf('settings.'), ...valuesOf('about.')]) {
    assert.doesNotMatch(text, /settings\.json|userData\//, `界面出现了内部配置文件路径：${text}`)
  }
})

test('必要的信息仍然保留', () => {
  /*
   * 反向断言：清理时容易一刀切，把「行为不可预期」「有风险」这类必须留的
   * 提示也删掉。这几条删了用户会做错事。
   */
  const required = [
    ['settings.portHint', /重启|顺延/], // 改端口会重启、占用会顺延：不看他以为改失败了
    ['settings.sharesHint', /只读|实时/], // 分享读的是实时文件，不是快照
    ['about.updateNote', /签名|发布者/], // 未签名会有未知发布者提示
    ['tabs.maxHint', /不限/], // 输入框写 0 的含义
  ]
  for (const [key, pattern] of required) {
    const hits = valuesOf(key)
    assert.ok(hits.length > 0, `${key} 是必要提示，不该被删掉`)
    assert.ok(
      hits.some(text => pattern.test(text)),
      `${key} 的内容偏离了它要传达的信息`,
    )
  }
})
