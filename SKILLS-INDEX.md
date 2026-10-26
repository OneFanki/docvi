# SKILLS-INDEX（docvi 项目技能索引）

> **本索引手工维护**：在本仓新增 / 删除 / 改名 `.agents/skills/` 下的 skill 时同步更新本表（治理规范见 `.agents/skills/skill-governance/SKILL.md`）。
> 命中下表场景时，读对应 `SKILL.md` 全文再动手。

| 技能               | 触发场景（description）                                                             | 路径                                 | 状态 |
| ------------------ | ----------------------------------------------------------------------------------- | ------------------------------------ | ---- |
| skill-governance   | 创建、编辑、合并或审查本项目 `.agents/skills/` 下的项目级 skill 时使用。            | `.agents/skills/skill-governance/`   | 生效 |
| content-model      | 改 `docs.config.yaml`、目录树生成、搜索索引、扫描规则、内容根零污染相关逻辑时使用。 | `.agents/skills/content-model/`      | 生效 |
| markdown-rendering | 改 Markdown 渲染管线、代码高亮、mermaid、锚点、正文排版时使用。                     | `.agents/skills/markdown-rendering/` | 生效 |
| component-protocol | 改 `<at-*>` 声明式协议、frontmatter components 段、组件运行时或组件数据协议时使用。 | `.agents/skills/component-protocol/` | 生效 |
| plugin-development | 新增、修改、打包或发布插件包（`plugin.json` / dist / docs / examples）时使用。      | `.agents/skills/plugin-development/` | 生效 |
| deployer-ops       | 改容器部署器、运维 API、git 编排、索引刷新队列、Docker 打包时使用。                 | `.agents/skills/deployer-ops/`       | 生效 |
