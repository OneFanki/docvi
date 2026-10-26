export { renderMarkdown, resolveLink, extractPluginBlocks, readFrontmatter } from './markdown.ts'
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
export { mermaidPass } from './mermaid.ts'

export { ComponentRegistry, mountDeclarativeComponents, mountPluginBlocks } from './components.ts'
export type { ComponentMeta, DeclarativeMount, MountOptions, RegistryEntry } from './components.ts'

export { colorLiteral } from './color-literal.ts'
