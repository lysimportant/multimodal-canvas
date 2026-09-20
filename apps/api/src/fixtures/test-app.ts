import { buildApp as buildRuntimeApp, type BuildAppOptions } from '../app';
import { MemoryAiSettingsStore } from './memory-ai-settings';

export type { BuildAppOptions } from '../app';

/** 单测显式装配内存目录；生产入口始终使用本人 New API 账号适配器。 */
export function buildApp(options: BuildAppOptions = {}) {
  return buildRuntimeApp({ settingsStore: new MemoryAiSettingsStore(), ...options });
}
