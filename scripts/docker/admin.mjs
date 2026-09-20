/** 由本机运维按 New API 不可变 ID 设置管理员，不按昵称或邮箱认领资源。 */
import { PrismaClient } from '@prisma/client';

/** 用户必须先通过配置的发行站点完成一次登录。 */
const externalUserId = process.argv[2]?.trim();
const issuer = process.env.NEW_API_ISSUER?.replace(/\/+$/, '');
if (!issuer || !externalUserId || process.argv.length !== 3) {
  throw new Error('请提供一个 New API 用户 ID，并配置 NEW_API_ISSUER。');
}
if (
  !process.env.NEW_API_ADMIN_USER_IDS?.split(',')
    .map((id) => id.trim())
    .includes(externalUserId)
) {
  throw new Error(
    '请先将此 ID 加入 NEW_API_ADMIN_USER_IDS 并重启 API；登录时按该配置同步管理员权限。',
  );
}
/** 只连接本容器注入的数据库，不允许命令行替换连接地址。 */
const prisma = new PrismaClient();
try {
  const identity = await prisma.newApiIdentity.findUnique({
    where: { issuer_externalUserId: { issuer, externalUserId } },
  });
  if (!identity || identity.status !== 'active') throw new Error('请先通过 New API 登录画布。');
  await prisma.user.update({ where: { id: identity.userId }, data: { role: 'ADMIN' } });
  console.log('指定 New API 身份已设为画布管理员，请重新登录。');
} catch {
  console.error('管理员设置失败，请检查发行站点、已登录身份及数据库状态。');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
