const resources = [
  { label: '文字', count: 0 },
  { label: '图片', count: 0 },
  { label: '音频', count: 0 },
  { label: '视频', count: 0 },
];

export function App() {
  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark" aria-label="Multimodal Canvas">
          <span className="brand-icon">MC</span>
          <span>Multimodal Canvas</span>
        </div>
        <div className="project-context">
          <span className="project-name">未命名项目</span>
          <span className="save-state">尚未保存</span>
        </div>
        <div className="topbar-actions">
          <button type="button" className="button button-secondary" disabled>
            导出
          </button>
          <button type="button" className="button button-primary" disabled>
            运行
          </button>
        </div>
      </header>

      <div className="workspace">
        <aside className="resource-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">资源库</p>
              <h1>项目资源</h1>
            </div>
            <button type="button" className="icon-button" aria-label="上传资源" disabled>
              +
            </button>
          </div>
          <label className="search-field">
            <span aria-hidden="true">⌕</span>
            <input type="search" placeholder="搜索资源" disabled />
          </label>
          <nav className="resource-filters" aria-label="资源类型">
            {resources.map((resource, index) => (
              <button
                type="button"
                className={`resource-filter ${index === 0 ? 'is-active' : ''}`}
                key={resource.label}
                disabled
              >
                <span>{resource.label}</span>
                <span className="resource-count">{resource.count}</span>
              </button>
            ))}
          </nav>
          <div className="empty-panel">
            <span className="empty-icon">+</span>
            <strong>还没有资源</strong>
            <p>上传素材后，可以从这里拖入画布。</p>
          </div>
        </aside>

        <section className="canvas-area" aria-label="工作流画布">
          <div className="canvas-grid" aria-hidden="true" />
          <div className="canvas-welcome">
            <span className="canvas-kicker">工作流画布</span>
            <h2>从一个节点开始</h2>
            <p>将资源拖入画布，或添加一个生成节点来构建你的多模态工作流。</p>
            <button type="button" className="button button-primary" disabled>
              添加节点
            </button>
          </div>
          <div className="canvas-controls" aria-label="画布控制">
            <button type="button" aria-label="缩小" disabled>
              −
            </button>
            <span>100%</span>
            <button type="button" aria-label="放大" disabled>
              +
            </button>
          </div>
        </section>

        <aside className="inspector-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">属性</p>
              <h1>节点设置</h1>
            </div>
          </div>
          <div className="inspector-empty">
            <span className="inspector-line" />
            <p>选择画布中的节点查看属性。</p>
          </div>
        </aside>
      </div>
    </main>
  );
}
