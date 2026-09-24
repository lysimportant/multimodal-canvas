/** 异步加载应用及其样式，避免主样式下载阻塞 HTML 启动提示的首绘。 */
void import('../main').catch((error: unknown) => {
  window.dispatchEvent(new Event('canvas:startup-error'));
  console.error('工作区启动失败', error);
});
