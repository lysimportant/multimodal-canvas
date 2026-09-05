/** 手动验收入口：需先构建包并显式注入授权及配置；不自动加载 .env 或重试。 */
import { runProviderAcceptance } from './acceptance-runner.js';

runProviderAcceptance(process.env).then(
  (report) => {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.status === 'succeeded' ? 0 : report.status === 'blocked' ? 2 : 1;
  },
  () => {
    process.stderr.write('{"status":"failed","code":"ACCEPTANCE_INTERNAL_ERROR"}\n');
    process.exitCode = 1;
  },
);
