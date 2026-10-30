export {
  renderMarkdown,
  resolveLink,
  extractPluginBlocks,
  readFrontmatter,
  toRootRelative,
} from './markdown.ts'
export type {
  ContainerSyntax,
  Frontmatter,
  FrontmatterSnapshot,
  OutlineEntry,
  RenderOptions,
  RenderResult,
} from './markdown.ts'

export { findPluginBlocks } from './plugin-blocks.ts'
export type { PluginBlockSpan, PluginSyntaxDeclaration } from './plugin-blocks.ts'

export { highlightPass } from './highlight.ts'
export { mermaidPass, resolveAppearance } from './mermaid.ts'
export { enhanceMermaidSvg } from './mermaid-hover.ts'

export { ComponentRegistry, mountDeclarativeComponents, mountPluginBlocks } from './components.ts'
export type { ComponentMeta, DeclarativeMount, MountOptions, RegistryEntry } from './components.ts'

export { colorLiteral } from './color-literal.ts'
