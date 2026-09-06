/** 管理员概览、用户维护、审计与系统状态页面。 */
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Check,
  Database,
  HardDrive,
  KeyRound,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Server,
  ShieldCheck,
  UserCheck,
  UserRound,
  Users,
} from 'lucide-react';
import { useState } from 'react';
import { AppLink } from '../routing';
import { managementRequest, queryString, type DeliveryResult, type ManagedUser } from './client';
import {
  formatBytes,
  formatDate,
  Modal,
  Notice,
  Pagination,
  QueryState,
  StatusBadge,
  useAction,
  UserIdentity,
} from './primitives';

/** 后台汇总只包含可公开给管理员的统计值。 */
type Overview = {
  users: { total: number; active: number; pending: number; disabled: number };
  resources: { total: number; storageBytes: number; unassigned: number };
  runs: { total: number; failed: number; active: number };
  mail: { configured: boolean; failed: number };
};

/** 后台第一屏展示可操作的统计、待处理事项及管理入口。 */
export function OverviewPage({ userId }: { userId: string }) {
  const query = useQuery({
    queryKey: ['management', userId, 'overview'],
    queryFn: ({ signal }) => managementRequest<Overview>('/admin/overview', { signal }),
  });
  const data = query.data;
  return (
    <>
      <header className="mg-heading">
        <div>
          <p>ADMINISTRATION</p>
          <h1>管理概览</h1>
        </div>
        <button
          className="mg-icon"
          type="button"
          title="刷新概览"
          aria-label="刷新概览"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          <RefreshCw size={18} className={query.isFetching ? 'mg-spin' : ''} />
        </button>
      </header>
      <QueryState
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        {data && (
          <>
            <div className="mg-stat-row">
              <AppLink to="/admin/users">
                <Users size={20} />
                <span>用户总数</span>
                <strong>{data.users.total}</strong>
                <small>{data.users.active} 位正常用户</small>
              </AppLink>
              <AppLink to="/admin/resources">
                <Database size={20} />
                <span>资源总数</span>
                <strong>{data.resources.total}</strong>
                <small>{formatBytes(data.resources.storageBytes)}</small>
              </AppLink>
              <AppLink to="/admin/runs">
                <Activity size={20} />
                <span>运行任务</span>
                <strong>{data.runs.total}</strong>
                <small>{data.runs.active} 项进行中</small>
              </AppLink>
              <AppLink to="/admin/settings/email">
                <Mail size={20} />
                <span>邮件服务</span>
                <strong className="mg-stat-text">
                  {data.mail.configured ? '已配置' : '待配置'}
                </strong>
                <small>{data.mail.failed} 封投递失败</small>
              </AppLink>
            </div>
            <section className="mg-section">
              <h2>待处理</h2>
              <div className="mg-action-list">
                <AppLink to="/admin/users">
                  <UserCheck size={19} />
                  <span>等待邮箱验证的用户</span>
                  <strong>{data.users.pending}</strong>
                  <ArrowRight size={17} />
                </AppLink>
                <AppLink to="/admin/resources">
                  <HardDrive size={19} />
                  <span>待确认归属的历史资源</span>
                  <strong>{data.resources.unassigned}</strong>
                  <ArrowRight size={17} />
                </AppLink>
                <AppLink to="/admin/runs">
                  <Activity size={19} />
                  <span>失败任务</span>
                  <strong>{data.runs.failed}</strong>
                  <ArrowRight size={17} />
                </AppLink>
                <AppLink to="/admin/settings/email">
                  <Mail size={19} />
                  <span>失败邮件</span>
                  <strong>{data.mail.failed}</strong>
                  <ArrowRight size={17} />
                </AppLink>
              </div>
            </section>
            <section className="mg-section">
              <h2>管理入口</h2>
              <div className="mg-shortcuts">
                <AppLink to="/admin/users">
                  <Users size={20} />
                  <span>用户管理</span>
                  <ArrowRight size={17} />
                </AppLink>
                <AppLink to="/admin/resources">
                  <Database size={20} />
                  <span>用户资源</span>
                  <ArrowRight size={17} />
                </AppLink>
                <AppLink to="/admin/audit">
                  <ShieldCheck size={20} />
                  <span>操作记录</span>
                  <ArrowRight size={17} />
                </AppLink>
                <AppLink to="/admin/system">
                  <Server size={20} />
                  <span>系统状态</span>
                  <ArrowRight size={17} />
                </AppLink>
              </div>
            </section>
          </>
        )}
      </QueryState>
    </>
  );
}

/** 用户列表响应的字段与管理 API 保持一致。 */
type UsersResult = { users: ManagedUser[]; total: number; page: number; pageSize: number };

/** 用户列表以服务端筛选和分页保证权限、计数及搜索的一致性。 */
export function UsersPage({ userId }: { userId: string }) {
  const [search, setSearch] = useState('');
  const [queryText, setQueryText] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [createdNotice, setCreatedNotice] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['management', userId, 'users', queryText, status, page],
    queryFn: ({ signal }) =>
      managementRequest<UsersResult>(
        `/admin/users${queryString({ query: queryText, status, page, pageSize: 20 })}`,
        { signal },
      ),
  });
  return (
    <>
      <header className="mg-heading">
        <div>
          <p>USERS</p>
          <h1>用户管理</h1>
        </div>
        <button type="button" className="mg-button is-primary" onClick={() => setCreating(true)}>
          <Plus size={17} />
          创建普通用户
        </button>
      </header>
      {createdNotice && <Notice value={{ kind: 'info', text: createdNotice }} />}
      <div className="mg-toolbar">
        <form
          className="mg-search"
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            setQueryText(search.trim());
          }}
        >
          <Search size={17} />
          <input
            type="search"
            aria-label="搜索用户"
            placeholder="搜索昵称或邮箱"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              if (!event.target.value) {
                setQueryText('');
                setPage(1);
              }
            }}
          />
          <button type="submit" className="mg-icon" title="搜索" aria-label="提交搜索">
            <ArrowRight size={16} />
          </button>
        </form>
        <select
          aria-label="用户状态"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setPage(1);
          }}
        >
          <option value="">全部状态</option>
          <option value="active">正常</option>
          <option value="pending">待验证</option>
          <option value="disabled">已禁用</option>
        </select>
        <button
          type="button"
          className="mg-icon"
          title="刷新用户"
          aria-label="刷新用户"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          <RefreshCw size={17} />
        </button>
      </div>
      <QueryState
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        empty={
          query.data?.users.length === 0
            ? queryText || status
              ? '没有符合条件的用户'
              : '暂无用户'
            : undefined
        }
      >
        <div className="mg-table-wrap">
          <table className="mg-table mg-user-table">
            <thead>
              <tr>
                <th>用户</th>
                <th>角色</th>
                <th>状态</th>
                <th>邮箱验证</th>
                <th>创建时间</th>
                <th>
                  <span className="mg-sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {query.data?.users.map((user) => (
                <tr key={user.id}>
                  <td>
                    <UserIdentity
                      name={user.displayName}
                      email={user.email}
                      avatarUrl={user.avatarUrl}
                    />
                  </td>
                  <td>{user.role === 'admin' ? '管理员' : '普通用户'}</td>
                  <td>
                    <StatusBadge value={user.status} />
                  </td>
                  <td>
                    {user.emailVerifiedAt ? (
                      <span className="mg-inline-good">
                        <Check size={15} />
                        已验证
                      </span>
                    ) : (
                      '待验证'
                    )}
                  </td>
                  <td>{formatDate(user.createdAt)}</td>
                  <td>
                    <AppLink
                      to={`/admin/users/${encodeURIComponent(user.id)}`}
                      className="mg-icon"
                      title={`查看${user.displayName || user.email}`}
                      aria-label={`查看${user.displayName || user.email}`}
                    >
                      <ArrowRight size={17} />
                    </AppLink>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryState>
      {query.data && (
        <Pagination
          page={page}
          pageSize={20}
          total={query.data.total}
          onChange={setPage}
          busy={query.isFetching}
        />
      )}
      {creating && (
        <CreateUserModal
          onClose={() => setCreating(false)}
          onCreated={(message) => {
            setCreatedNotice(message);
            setCreating(false);
            setPage(1);
            void query.refetch();
          }}
        />
      )}
    </>
  );
}

/** 邀请创建用户不设置可登录密码，收件人验证邮箱后自行设置。 */
function CreateUserModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (message: string) => void;
}) {
  const action = useAction();
  return (
    <Modal title="创建普通用户" onClose={onClose} busy={action.busy}>
      <form
        className="mg-form"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          void action.execute(async () => {
            const response = await managementRequest<DeliveryResult & { user: ManagedUser }>(
              '/admin/users',
              {
                method: 'POST',
                body: {
                  email: String(data.get('email') ?? '').trim(),
                  displayName: String(data.get('displayName') ?? '').trim(),
                  bio: String(data.get('bio') ?? '').trim(),
                },
              },
            );
            onCreated(
              response.delivery.status === 'failed'
                ? '用户已创建，但邀请邮件发送失败。请在用户详情中重发邀请。'
                : '用户已创建，邀请邮件已提交发送，等待收件人验证并设置密码。',
            );
          });
        }}
      >
        <label className="mg-field">
          <span>邮箱</span>
          <input name="email" type="email" required autoComplete="off" maxLength={254} autoFocus />
        </label>
        <label className="mg-field">
          <span>昵称</span>
          <input name="displayName" required maxLength={120} autoComplete="off" />
        </label>
        <label className="mg-field">
          <span>个人简介</span>
          <textarea name="bio" maxLength={500} rows={3} />
        </label>
        <Notice value={action.notice} />
        <div className="mg-form-actions">
          <button className="mg-button is-primary" disabled={action.busy}>
            <Mail size={16} />
            {action.busy ? '正在创建' : '创建并发送邀请'}
          </button>
          <button className="mg-button" type="button" disabled={action.busy} onClick={onClose}>
            取消
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** 用户详情包括业务资料、项目和服务端计数。 */
type UserDetail = {
  user: ManagedUser;
  projects: { id: string; name: string; updatedAt: string; status?: string }[];
  stats: { resourceCount: number; storageBytes: number; runCount: number };
};

/** 用户详情提供资料和状态管理；本人邮箱变更转到账户安全页验证当前密码。 */
export function UserDetailPage({ actorId, userId }: { actorId: string; userId: string }) {
  const query = useQuery({
    queryKey: ['management', actorId, 'user', userId],
    queryFn: ({ signal }) =>
      managementRequest<UserDetail>(`/admin/users/${encodeURIComponent(userId)}`, { signal }),
  });
  const action = useAction();
  const [edit, setEdit] = useState(false);
  const [changeEmail, setChangeEmail] = useState(false);
  const [confirmStatus, setConfirmStatus] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const data = query.data;
  /** 发送管理邮件后展示真实入队/失败结果，不暗示目标用户已完成验证。 */
  const sendMail = async (endpoint: string) => {
    const result = await managementRequest<DeliveryResult>(
      `/admin/users/${encodeURIComponent(userId)}/${endpoint}`,
      { method: 'POST' },
    );
    action.setNotice({
      kind: result.delivery.status === 'failed' ? 'error' : 'success',
      text:
        result.delivery.status === 'failed'
          ? '邮件发送失败，请检查邮件服务后重试'
          : '邮件已提交发送，等待目标用户完成验证',
    });
  };
  return (
    <>
      <AppLink className="mg-back" to="/admin/users">
        <ArrowLeft size={16} />
        用户管理
      </AppLink>
      <header className="mg-heading">
        <div>
          <p>USER DETAIL</p>
          <h1>{data?.user.displayName || '用户详情'}</h1>
        </div>
        {data && (
          <button type="button" className="mg-button" onClick={() => setEdit(true)}>
            <Pencil size={16} />
            编辑资料
          </button>
        )}
      </header>
      <Notice value={action.notice} />
      <QueryState
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        {data && (
          <>
            <section className="mg-user-summary">
              <UserIdentity
                name={data.user.displayName}
                email={data.user.email}
                avatarUrl={data.user.avatarUrl}
              />
              <StatusBadge value={data.user.status} />
              <span className="mg-muted">{data.user.role === 'admin' ? '管理员' : '普通用户'}</span>
              <span className="mg-summary-spacer" />
              <AppLink
                className="mg-button"
                to={`/admin/users/${encodeURIComponent(userId)}/resources`}
              >
                <Database size={16} />
                查看资源
              </AppLink>
            </section>
            <div className="mg-stat-row is-three">
              <div>
                <span>项目</span>
                <strong>{data.projects.length}</strong>
              </div>
              <div>
                <span>资源</span>
                <strong>{data.stats.resourceCount}</strong>
                <small>{formatBytes(data.stats.storageBytes)}</small>
              </div>
              <div>
                <span>任务</span>
                <strong>{data.stats.runCount}</strong>
              </div>
            </div>
            <section className="mg-section">
              <h2>账户信息</h2>
              <dl className="mg-details is-horizontal">
                <div>
                  <dt>邮箱</dt>
                  <dd>{data.user.email}</dd>
                </div>
                <div>
                  <dt>邮箱验证</dt>
                  <dd>
                    {data.user.emailVerifiedAt
                      ? `已验证 · ${formatDate(data.user.emailVerifiedAt)}`
                      : '等待验证'}
                  </dd>
                </div>
                <div>
                  <dt>个人简介</dt>
                  <dd>{data.user.bio || '未填写'}</dd>
                </div>
                <div>
                  <dt>创建时间</dt>
                  <dd>{formatDate(data.user.createdAt)}</dd>
                </div>
              </dl>
              <div className="mg-form-actions">
                {!data.user.emailVerifiedAt && (
                  <button
                    className="mg-button"
                    type="button"
                    disabled={action.busy}
                    onClick={() => void action.execute(() => sendMail('invite'))}
                  >
                    <Mail size={16} />
                    重发邀请
                  </button>
                )}
                {actorId === userId ? (
                  <AppLink className="mg-button" to="/account/security">
                    <Mail size={16} />
                    更换邮箱
                  </AppLink>
                ) : (
                  <button
                    className="mg-button"
                    type="button"
                    disabled={action.busy}
                    onClick={() => setChangeEmail(true)}
                  >
                    <Mail size={16} />
                    更换邮箱
                  </button>
                )}
                <button
                  className="mg-button"
                  type="button"
                  disabled={action.busy || !data.user.emailVerifiedAt}
                  onClick={() => setConfirmReset(true)}
                >
                  <KeyRound size={16} />
                  发送密码重置
                </button>
                <button
                  className={`mg-button${data.user.status === 'disabled' ? '' : ' is-danger'}`}
                  type="button"
                  disabled={action.busy}
                  onClick={() => setConfirmStatus(true)}
                >
                  <UserRound size={16} />
                  {data.user.status === 'disabled' ? '恢复用户' : '禁用用户'}
                </button>
              </div>
            </section>
            <section className="mg-section">
              <h2>项目</h2>
              <QueryState empty={data.projects.length === 0 ? '该用户尚未创建项目' : undefined}>
                <div className="mg-table-wrap">
                  <table className="mg-table">
                    <thead>
                      <tr>
                        <th>项目名称</th>
                        <th>更新时间</th>
                        <th>资源</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.projects.map((project) => (
                        <tr key={project.id}>
                          <td>{project.name}</td>
                          <td>{formatDate(project.updatedAt)}</td>
                          <td>
                            <AppLink
                              to={`/admin/users/${encodeURIComponent(userId)}/resources?projectId=${encodeURIComponent(project.id)}`}
                              className="mg-text-button"
                            >
                              查看资源
                              <ArrowRight size={15} />
                            </AppLink>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </QueryState>
            </section>
          </>
        )}
      </QueryState>
      {edit && data && (
        <EditUserModal
          user={data.user}
          onClose={() => setEdit(false)}
          onSaved={() => {
            setEdit(false);
            void query.refetch();
            action.setNotice({ kind: 'success', text: '用户资料已保存' });
          }}
        />
      )}
      {changeEmail && data && actorId !== userId && (
        <UserEmailModal
          user={data.user}
          onClose={() => setChangeEmail(false)}
          onSaved={(message) => {
            setChangeEmail(false);
            action.setNotice({ kind: 'info', text: message });
          }}
        />
      )}
      {confirmStatus && data && (
        <Modal
          title={data.user.status === 'disabled' ? '恢复用户' : '禁用用户'}
          onClose={() => setConfirmStatus(false)}
          busy={action.busy}
        >
          <p>目标用户：{data.user.displayName || data.user.email}</p>
          <p className="mg-muted">
            {data.user.status === 'disabled'
              ? '恢复后，已验证的用户可以重新登录。'
              : '禁用后该用户将无法登录，现有登录会话会被撤销；资源和项目会保留。'}
          </p>
          <Notice value={action.notice} />
          <div className="mg-form-actions">
            <button
              className="mg-button is-primary"
              disabled={action.busy}
              onClick={() =>
                void action.execute(async () => {
                  await managementRequest(`/admin/users/${encodeURIComponent(userId)}`, {
                    method: 'PATCH',
                    body: { status: data.user.status === 'disabled' ? 'active' : 'disabled' },
                  });
                  setConfirmStatus(false);
                  await query.refetch();
                }, '用户状态已更新')
              }
            >
              确认{data.user.status === 'disabled' ? '恢复' : '禁用'}
            </button>
            <button
              className="mg-button"
              disabled={action.busy}
              onClick={() => setConfirmStatus(false)}
            >
              取消
            </button>
          </div>
        </Modal>
      )}
      {confirmReset && data && (
        <Modal title="发送密码重置邮件" onClose={() => setConfirmReset(false)} busy={action.busy}>
          <p>将向 {data.user.email} 发送验证邮件，由用户自行设置新密码。</p>
          <Notice value={action.notice} />
          <div className="mg-form-actions">
            <button
              className="mg-button is-primary"
              disabled={action.busy}
              onClick={() =>
                void action.execute(async () => {
                  await sendMail('password-reset');
                  setConfirmReset(false);
                })
              }
            >
              <Mail size={16} />
              发送邮件
            </button>
            <button
              className="mg-button"
              disabled={action.busy}
              onClick={() => setConfirmReset(false)}
            >
              取消
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

/** 白名单用户资料编辑，不暴露角色、密码和审计字段。 */
function EditUserModal({
  user,
  onClose,
  onSaved,
}: {
  user: ManagedUser;
  onClose: () => void;
  onSaved: () => void;
}) {
  const action = useAction();
  return (
    <Modal title="编辑用户资料" onClose={onClose} busy={action.busy}>
      <form
        className="mg-form"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          void action.execute(async () => {
            await managementRequest(`/admin/users/${encodeURIComponent(user.id)}`, {
              method: 'PATCH',
              body: {
                displayName: String(data.get('displayName') ?? '').trim(),
                bio: String(data.get('bio') ?? '').trim(),
                avatarUrl: String(data.get('avatarUrl') ?? '').trim(),
              },
            });
            onSaved();
          });
        }}
      >
        <label className="mg-field">
          <span>昵称</span>
          <input
            name="displayName"
            defaultValue={user.displayName ?? ''}
            required
            maxLength={120}
            autoFocus
          />
        </label>
        <label className="mg-field">
          <span>个人简介</span>
          <textarea name="bio" defaultValue={user.bio ?? ''} maxLength={500} rows={4} />
        </label>
        <label className="mg-field">
          <span>头像地址</span>
          <input name="avatarUrl" defaultValue={user.avatarUrl ?? ''} maxLength={2048} />
        </label>
        <Notice value={action.notice} />
        <div className="mg-form-actions">
          <button className="mg-button is-primary" disabled={action.busy}>
            <Save size={16} />
            保存资料
          </button>
          <button className="mg-button" type="button" disabled={action.busy} onClick={onClose}>
            取消
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** 修改目标邮箱仅发起验证，在验证通过前保留原绑定。 */
function UserEmailModal({
  user,
  onClose,
  onSaved,
}: {
  user: ManagedUser;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const action = useAction();
  return (
    <Modal title="更换用户邮箱" onClose={onClose} busy={action.busy}>
      <form
        className="mg-form"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          void action.execute(async () => {
            const result = await managementRequest<DeliveryResult>(
              `/admin/users/${encodeURIComponent(user.id)}/email`,
              { method: 'POST', body: { email: String(data.get('email') ?? '').trim() } },
            );
            onSaved(
              result.delivery.status === 'failed'
                ? '邮箱变更请求已保存，但邮件发送失败，请检查邮件配置后重试。'
                : '新邮箱验证邮件已提交发送，验证完成前保留原邮箱。',
            );
          });
        }}
      >
        <label className="mg-field">
          <span>当前邮箱</span>
          <input value={user.email} disabled />
        </label>
        <label className="mg-field">
          <span>新邮箱</span>
          <input name="email" type="email" required maxLength={254} autoFocus />
        </label>
        <Notice value={action.notice} />
        <div className="mg-form-actions">
          <button className="mg-button is-primary" disabled={action.busy}>
            <Mail size={16} />
            发送验证邮件
          </button>
          <button className="mg-button" type="button" disabled={action.busy} onClick={onClose}>
            取消
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** 审计数据只显示服务端脱敏摘要。 */
type AuditResult = {
  events: {
    id: string;
    actorId?: string;
    action: string;
    targetId?: string;
    ownerId?: string;
    summary: string;
    createdAt: string;
  }[];
  total: number;
  page: number;
  pageSize: number;
};

/** 管理审计分页展示；记录不可在界面中编辑或删除。 */
export function AuditPage({ userId }: { userId: string }) {
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['management', userId, 'audit', page],
    queryFn: ({ signal }) =>
      managementRequest<AuditResult>(`/admin/audit${queryString({ page, pageSize: 30 })}`, {
        signal,
      }),
  });
  return (
    <>
      <header className="mg-heading">
        <div>
          <p>AUDIT</p>
          <h1>操作记录</h1>
        </div>
        <button
          type="button"
          className="mg-icon"
          aria-label="刷新操作记录"
          title="刷新操作记录"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={17} />
        </button>
      </header>
      <QueryState
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        empty={query.data?.events.length === 0 ? '暂无操作记录' : undefined}
      >
        <div className="mg-table-wrap">
          <table className="mg-table mg-audit-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>操作</th>
                <th>操作者</th>
                <th>对象</th>
                <th>摘要</th>
              </tr>
            </thead>
            <tbody>
              {query.data?.events.map((event) => (
                <tr key={event.id}>
                  <td>{formatDate(event.createdAt)}</td>
                  <td>
                    <code>{event.action}</code>
                  </td>
                  <td>
                    <span className="mg-truncate" title={event.actorId}>
                      {event.actorId || '系统'}
                    </span>
                  </td>
                  <td>
                    <span className="mg-truncate" title={event.targetId}>
                      {event.targetId || '系统'}
                    </span>
                  </td>
                  <td>
                    {typeof event.summary === 'string'
                      ? event.summary
                      : JSON.stringify(event.summary)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryState>
      {query.data && (
        <Pagination
          page={page}
          pageSize={30}
          total={query.data.total}
          onChange={setPage}
          busy={query.isFetching}
        />
      )}
    </>
  );
}

/** 系统状态契约，邮件认证密码在服务端已剔除。 */
type SystemStatus = {
  api: { status: string };
  storage: { status: string };
  queue: { status: string };
  mail: {
    configured: boolean;
    host?: string;
    port?: number;
    secure?: boolean;
    from?: string;
    deliveries: {
      id: string;
      to: string;
      purpose: string;
      status: string;
      createdAt: string;
      updatedAt?: string;
      error?: string;
    }[];
  };
};

/** 真实系统和邮件投递状态，重试仅由管理员显式发起。 */
export function SystemPage({ userId, emailOnly = false }: { userId: string; emailOnly?: boolean }) {
  const query = useQuery({
    queryKey: ['management', userId, 'system'],
    queryFn: ({ signal }) => managementRequest<SystemStatus>('/admin/system', { signal }),
    refetchInterval: 30_000,
  });
  const data = query.data;
  return (
    <>
      <header className="mg-heading">
        <div>
          <p>{emailOnly ? 'EMAIL' : 'SYSTEM'}</p>
          <h1>{emailOnly ? '邮件服务' : '系统状态'}</h1>
        </div>
        <button
          className="mg-button"
          type="button"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={16} className={query.isFetching ? 'mg-spin' : ''} />
          刷新状态
        </button>
      </header>
      <QueryState
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        {data && (
          <>
            {!emailOnly && (
              <div className="mg-health-grid">
                {[
                  { name: 'API 服务', value: data.api.status, icon: Server },
                  { name: '资源索引', value: data.storage.status, icon: Database },
                  { name: '任务队列', value: data.queue.status, icon: Activity },
                ].map(({ name, value, icon: Icon }) => (
                  <div key={name}>
                    <Icon size={21} />
                    <strong>{name}</strong>
                    <span
                      className={`mg-badge ${value === 'ok' || value === 'available' ? 'is-active' : value === 'unknown' ? 'is-pending' : 'is-failed'}`}
                    >
                      {value === 'ok' || value === 'available'
                        ? '正常'
                        : value === 'unknown'
                          ? '未检测'
                          : '异常'}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <section className="mg-section">
              <h2>邮件配置</h2>
              <dl className="mg-details is-horizontal">
                <div>
                  <dt>状态</dt>
                  <dd>
                    <span
                      className={`mg-badge ${data.mail.configured ? 'is-active' : 'is-failed'}`}
                    >
                      {data.mail.configured ? '已配置' : '未配置'}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>SMTP 服务器</dt>
                  <dd>{data.mail.host || '未配置'}</dd>
                </div>
                <div>
                  <dt>端口与加密</dt>
                  <dd>
                    {data.mail.port
                      ? `${data.mail.port} · ${data.mail.secure ? 'TLS' : 'STARTTLS'}`
                      : '未配置'}
                  </dd>
                </div>
                <div>
                  <dt>发件人</dt>
                  <dd>{data.mail.from || '未配置'}</dd>
                </div>
              </dl>
            </section>
            <section className="mg-section">
              <h2>最近邮件投递</h2>
              <QueryState
                empty={data.mail.deliveries.length === 0 ? '暂无邮件投递记录' : undefined}
              >
                <div className="mg-table-wrap">
                  <table className="mg-table">
                    <thead>
                      <tr>
                        <th>收件人</th>
                        <th>用途</th>
                        <th>状态</th>
                        <th>提交时间</th>
                        <th>错误</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.mail.deliveries.map((delivery) => (
                        <tr key={delivery.id}>
                          <td>{delivery.to}</td>
                          <td>
                            {{
                              bootstrap: '管理员初始化',
                              invite: '用户邀请',
                              register: '注册验证',
                              email: '更换邮箱',
                              reset: '密码重置',
                            }[delivery.purpose] || delivery.purpose}
                          </td>
                          <td>
                            <StatusBadge
                              value={delivery.status}
                              label={
                                delivery.status === 'pending'
                                  ? '待发送'
                                  : delivery.status === 'accepted'
                                    ? '邮件服务已接收'
                                    : undefined
                              }
                            />
                          </td>
                          <td>{formatDate(delivery.createdAt)}</td>
                          <td>{delivery.error || '无'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </QueryState>
            </section>
          </>
        )}
      </QueryState>
    </>
  );
}
