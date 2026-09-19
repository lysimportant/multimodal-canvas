import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, SlidersHorizontal } from 'lucide-react';
import type { AuthUser } from '../auth-client';
import { AppLink, appPaths } from '../routing';
import { PageFrame } from '../pages/PageFrame';
import { QueryState } from '../management/primitives';
import { mediaLabels } from '../workspace/contracts';
import { fetchMarketplace, marketplacePriceLabel } from './client';
import './models-page.css';

/** 用户模型广场与节点共用已发布目录；搜索筛选不会发起生成。 */
export function ModelsPage({ user, onLogin }: { user: AuthUser | null; onLogin: () => void }) {
  const [query, setQuery] = useState('');
  const [mediaType, setMediaType] = useState('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const models = useQuery({
    queryKey: ['marketplace', user?.id, query, mediaType, page],
    enabled: Boolean(user),
    queryFn: ({ signal }) => fetchMarketplace({ query, mediaType, page, signal }),
    retry: false,
  });
  return (
    <PageFrame route={{ id: 'models', pathname: '/models' }} mainClassName="model-square">
      <header className="model-square-heading">
        <div>
          <span className="model-square-eyebrow">模型与价格</span>
          <h1>模型广场</h1>
          <p>选择创作能力，按确认的人民币报价使用。</p>
        </div>
        <div className="model-square-actions">
          <AppLink to="/account/billing" className="button">
            余额与账单
          </AppLink>
          {user?.role === 'admin' && (
            <AppLink to="/admin/models" className="button">
              <SlidersHorizontal size={16} />
              管理模型
            </AppLink>
          )}
        </div>
      </header>
      {!user ? (
        <section className="model-square-empty">
          <h2>登录后查看可用模型</h2>
          <button className="button button-primary" onClick={onLogin}>
            登录
          </button>
        </section>
      ) : (
        <>
          <div className="model-square-filters">
            <label className="model-square-search">
              <Search size={18} />
              <input
                aria-label="搜索模型"
                placeholder="搜索模型名称"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
              />
            </label>
            <div className="model-square-tabs" role="group" aria-label="模型类型">
              {[['', '全部'], ...Object.entries(mediaLabels)].map(([value, label]) => (
                <button
                  key={value}
                  aria-pressed={mediaType === value}
                  onClick={() => {
                    setMediaType(value!);
                    setPage(1);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <QueryState
            loading={models.isLoading}
            error={models.error}
            empty={models.data?.items.length === 0 ? '暂无符合条件的已上架模型' : undefined}
            onRetry={() => void models.refetch()}
          >
            <div className="model-square-list">
              {models.data?.items.map((model) => (
                <article key={model.id} className="model-square-card">
                  <div className="model-square-card-top">
                    <span className="model-square-type">{mediaLabels[model.mediaType]}</span>
                    <span
                      className={
                        model.availability === 'available'
                          ? 'model-square-available'
                          : 'model-square-unavailable'
                      }
                    >
                      {model.availability === 'available' ? '可用' : '暂不可用'}
                    </span>
                  </div>
                  <h2>{model.name}</h2>
                  <p className="model-square-description">
                    {model.description || '使用已验证的模型能力开始创作。'}
                  </p>
                  <div className="model-square-price">
                    {marketplacePriceLabel(model.pricing?.rule)}
                  </div>
                  {model.availabilityReason && <p role="status">{model.availabilityReason}</p>}
                  <div className="model-square-card-actions">
                    <button
                      onClick={() => setExpanded(expanded === model.id ? null : model.id)}
                      aria-expanded={expanded === model.id}
                    >
                      规格与价格详情
                    </button>
                    <AppLink to={appPaths.workspace}>进入工作台</AppLink>
                  </div>
                  {expanded === model.id && (
                    <div className="model-square-details">
                      <p>价格版本 {model.pricing?.revision ?? '—'} · 提交前确认最高费用</p>
                      {[
                        ...Object.entries(model.specifications),
                        ...Object.entries(model.capabilities),
                        ...Object.entries(model.limitations),
                      ].map(([key, value], index) => (
                        <div key={`${key}-${index}`}>
                          <strong>{key}</strong>
                          <span>{typeof value === 'string' ? value : JSON.stringify(value)}</span>
                        </div>
                      ))}
                      {model.pricing?.rule.variants?.map((variant, index) => (
                        <p key={index}>
                          {Object.entries(variant.parameters)
                            .map(([key, value]) => `${key}: ${value}`)
                            .join(' · ')}{' '}
                          —{' '}
                          {marketplacePriceLabel({
                            ...model.pricing!.rule,
                            ...variant,
                            variants: undefined,
                          } as typeof model.pricing.rule)}
                        </p>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </div>
          </QueryState>
          {(models.data?.total ?? 0) > 100 && (
            <div className="model-square-pagination">
              <button disabled={page === 1} onClick={() => setPage(page - 1)}>
                上一页
              </button>
              <span>第 {page} 页</span>
              <button
                disabled={page * 100 >= (models.data?.total ?? 0)}
                onClick={() => setPage(page + 1)}
              >
                下一页
              </button>
            </div>
          )}
        </>
      )}
    </PageFrame>
  );
}
