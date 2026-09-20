import { AuthService } from '../auth-service';
import { MemoryAuthStore } from '../auth-store';

/** 非认证业务回归使用显式合成身份；真实 New API 回调另由账号集成测试验证。 */
export class TestAuthContext {
  readonly store = new MemoryAuthStore();
  readonly auth = new AuthService({
    store: this.store,
    jwtSecret: process.env.API_JWT_SECRET || 'synthetic-test-secret',
  });

  /** 可注入 buildApp 的同一存储和会话服务，禁止从测试 HTTP 请求传入用户对象。 */
  get appOptions() {
    return { authStore: this.store, authService: this.auth };
  }

  /** 创建或复用测试用户并签发会话；仅测试夹具使用邮箱查找合成数据。 */
  async session(input: { email: string; displayName?: string; role?: 'user' | 'admin' }) {
    const user =
      (await this.store.findUserByEmail(input.email)) ??
      (await this.store.createUser({
        ...input,
        status: 'active',
      }));
    return this.auth.issueToken(user);
  }
}

/** 沿用注入响应读取形状，业务回归无需调用已退役的注册/验证接口。 */
export async function issueTestSession(
  _app: unknown,
  context: TestAuthContext,
  input: { email: string; password?: string; displayName?: string },
) {
  const result = await context.session(input);
  return { json: () => result, statusCode: 200, body: JSON.stringify(result) };
}
