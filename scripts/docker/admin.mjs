/** 仅由本机 Docker 操作者将明确指定的已注册账号设为管理员，不修改密码或其它账号。 */
import { PrismaClient } from '@prisma/client';

/** 用户显式指定的邮箱，采用现有注册流程相同的大小写规范化。 */
const email = process.argv[2]?.trim().toLowerCase();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || process.argv.length !== 3) {
  throw new Error('Provide exactly one registered email address.');
}
/** 只连接本容器注入的数据库，不允许命令行替换连接地址。 */
const prisma = new PrismaClient();
try {
  const result = await prisma.user.updateMany({ where: { email }, data: { role: 'ADMIN' } });
  if (result.count !== 1) throw new Error('Register this account in the Web application first.');
  console.log(
    'The specified account is now an administrator. Sign in again to refresh the session.',
  );
} catch {
  console.error(
    'Administrator setup failed. Verify that the account is registered and the database is available.',
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
