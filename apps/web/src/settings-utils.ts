import { mediaTypes, type MediaType, type ModelSelection } from '@multimodal-canvas/domain';

export type AiSettingsFormValues = {
  baseUrl: string;
  apiKey: string;
  configured: boolean;
};

export type AiSettingsFormErrors = Partial<Record<'baseUrl' | 'apiKey', string>>;

/** Validate the client-side fields without changing the settings API payload. */
export function validateAiSettingsForm(values: AiSettingsFormValues): AiSettingsFormErrors {
  const errors: AiSettingsFormErrors = {};
  let validBaseUrl = false;

  try {
    const parsed = new URL(values.baseUrl.trim());
    validBaseUrl =
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname);
  } catch {
    validBaseUrl = false;
  }

  if (!validBaseUrl) errors.baseUrl = '请输入有效的 HTTP(S) Base URL';
  if (!values.configured && values.apiKey.trim().length === 0) {
    errors.apiKey = '未配置凭据时请输入 API Key';
  }

  return errors;
}

/** 类型默认模型的编辑范围；全局写在当前活动凭据上，项目写在项目覆盖上。 */
export type SettingsScope = 'global' | 'project';

/** 单个媒体类型的默认模型来源层，顺序就是服务端的解析优先级。 */
export type MediaDefaultSource = 'run' | 'node' | 'project' | 'global' | 'unset';

/** 设置面板只读取凭据的可公开摘要，不接触 Key 明文。 */
export type KnownCredential = {
  id: string;
  baseUrl: string;
  keyFingerprint: string;
  /** 服务端裁剪的安全尾号，缺失时不回退显示内部指纹。 */
  keySuffix?: string;
  active: boolean;
};

/** 类型默认模型的已解析组合：模型与凭据始终成对出现。 */
export type ResolvedMediaDefault = {
  /** 精确模型 ID；未解析到任何一层时为 undefined。 */
  modelAlias?: string;
  /** 提供该模型的凭据 ID；继承全局时就是活动凭据。 */
  credentialId?: string;
  /** 生效的来源层。 */
  source: MediaDefaultSource;
  /** 该来源层来自哪个范围的默认值。 */
  scope?: SettingsScope;
  /**
   * 失效原因：`credential-missing` 表示引用的 Key 已被删除，
   * `model-missing` 表示模型不在该 Key 的当前目录中。两者都不会回退到其他 Key。
   */
  invalidReason?: 'credential-missing' | 'model-missing';
};

/** 四个类型默认行按此顺序展示。 */
export const mediaDefaultOrder: readonly MediaType[] = mediaTypes;

/** 类型默认行的表头文案，与其他「文字/图片/音频/视频」标签保持一致。 */
export const mediaDefaultLabels: Record<MediaType, string> = {
  text: '文字生成',
  image: '图片生成',
  audio: '音频生成',
  video: '视频生成',
};

/** 取默认模型或节点覆盖中记录的精确模型 ID。 */
export function modelSelectionAlias(
  selection: string | ModelSelection | null | undefined,
): string | undefined {
  if (!selection) return undefined;
  const alias = typeof selection === 'string' ? selection : selection.modelAlias;
  return alias && alias.length > 0 ? alias : undefined;
}

/** 取默认模型或节点覆盖中记录的凭据引用；未绑定时返回 undefined，表示沿用活动连接。 */
export function modelSelectionCredentialId(
  selection: string | ModelSelection | null | undefined,
): string | undefined {
  if (!selection || typeof selection === 'string') return undefined;
  return selection.credentialId && selection.credentialId.length > 0
    ? selection.credentialId
    : undefined;
}

/** 按范围取某个媒体类型已保存的默认值；项目范围读项目覆盖，全局范围读平台默认。 */
export function scopedDefaultSelection(
  scope: SettingsScope,
  mediaType: MediaType,
  defaults: {
    project: Partial<Record<MediaType, string | ModelSelection>>;
    global: Partial<Record<MediaType, string | ModelSelection>>;
  },
): string | ModelSelection | undefined {
  return scope === 'project' ? defaults.project[mediaType] : defaults.global[mediaType];
}

/** 在凭据清单中查找凭据；找不到说明该 Key 已被删除，调用方必须显示失效状态。 */
export function findCredential(
  credentials: readonly KnownCredential[],
  credentialId?: string,
): KnownCredential | undefined {
  if (!credentialId) return undefined;
  return credentials.find((credential) => credential.id === credentialId);
}

/** 格式化服务端提供的安全尾号；前缀遮罩始终保留，缺失时提示不可用。 */
export function credentialKeyLabel(credential: { keySuffix?: string }): string {
  return credential.keySuffix ? `…${credential.keySuffix}` : '尾号不可用';
}

/** 凭据展示名：地址加安全尾号；连接匹配仍使用 ID 与内部指纹。 */
export function credentialSourceLabel(credential: { baseUrl: string; keySuffix?: string }): string {
  return `${credential.baseUrl} · ${credentialKeyLabel(credential)}`;
}

/** 模型选择项：同一个模型 ID 来自不同 Key 时靠凭据来源保持可区分。 */
export type ModelChoice = {
  /** 精确模型 ID，直接作为保存值。 */
  value: string;
  /** 展示名称，未命名时回退到模型 ID。 */
  label: string;
  /** 凭据来源文案，永远参与展示。 */
  source: string;
  /** 提供该模型的凭据 ID。 */
  credentialId?: string;
};

/**
 * 把模型目录转换成可搜索选项；每个模型都带上提供它的凭据来源。
 * @param models 模型目录条目，可同时包含多个凭据的模型。
 * @param mediaType 需要过滤的媒体类型；模型未声明类型时不展示。
 * @param credentials 已保存的凭据摘要，用于把 `credentialId` 转成可读来源。
 */
export function modelChoicesForMediaType(
  models: readonly {
    id: string;
    name: string;
    mediaTypes: readonly MediaType[];
    credentialId?: string;
    credentialLabel?: string;
  }[],
  mediaType: MediaType,
  credentials: readonly KnownCredential[],
): ModelChoice[] {
  return models
    .filter((model) => model.mediaTypes.includes(mediaType))
    .map((model) => {
      const credential = findCredential(credentials, model.credentialId);
      return {
        value: model.id,
        label: model.name || model.id,
        source:
          model.credentialLabel ??
          (credential ? credentialSourceLabel(credential) : '当前 API Key'),
        ...(model.credentialId ? { credentialId: model.credentialId } : {}),
      };
    });
}

/** 解析类型默认时用到的全部输入；默认值来自服务端的项目、凭据和平台三层存储。 */
export type MediaDefaultResolutionInput = {
  /** 项目类型默认；没有项目上下文时传空对象。 */
  projectDefaults: Partial<Record<MediaType, string | ModelSelection>>;
  /** 平台全局类型默认（`AiSettings.defaultModels`）。 */
  globalDefaults: Partial<Record<MediaType, string | ModelSelection>>;
  /** 已保存凭据摘要，用于校验凭据仍然存在。 */
  credentials: readonly KnownCredential[];
  /** 当前活动凭据 ID；未绑定凭据的默认值由它提供。 */
  activeCredentialId?: string;
  /** 单节点显式覆盖；设置面板不传，节点编辑器可传入。 */
  nodeOverride?: string | ModelSelection | null;
  /** 本次运行显式配置；设置面板不传。 */
  runOverride?: string | ModelSelection | null;
};

/**
 * 按服务端优先级解析某个媒体类型的默认模型与凭据。
 *
 * 解析顺序：本次运行显式配置 > 单节点显式配置 > 项目类型默认 > 类型默认。
 * 类型默认由 `globalDefaults` 提供；某个连接自己的类型默认可由调用方先查出，
 * 通过 `globalDefaults` 传入，从而让模型与凭据保持同一对组合，不会出现「模型 A 配 Key B」。
 * 引用的 Key 已被删除时只返回失效状态，不自动改用其他 Key。
 *
 * @param mediaType 需要解析的媒体类型。
 * @param input 项目默认、类型默认、凭据清单和覆盖值。
 */
export function resolveMediaDefault(
  mediaType: MediaType,
  input: MediaDefaultResolutionInput,
): ResolvedMediaDefault {
  const explicitAlias = modelSelectionAlias(input.runOverride);
  if (explicitAlias) {
    return {
      modelAlias: explicitAlias,
      credentialId: modelSelectionCredentialId(input.runOverride) ?? input.activeCredentialId,
      source: 'run',
    };
  }

  const nodeAlias = modelSelectionAlias(input.nodeOverride);
  if (nodeAlias) {
    return {
      modelAlias: nodeAlias,
      credentialId: modelSelectionCredentialId(input.nodeOverride) ?? input.activeCredentialId,
      source: 'node',
    };
  }

  const projectSelection = input.projectDefaults[mediaType];
  const projectAlias = modelSelectionAlias(projectSelection);
  if (projectAlias) {
    const referencedCredentialId = modelSelectionCredentialId(projectSelection);
    if (referencedCredentialId) {
      const credential = findCredential(input.credentials, referencedCredentialId);
      return credential
        ? {
            modelAlias: projectAlias,
            credentialId: credential.id,
            source: 'project',
            scope: 'project',
          }
        : // 引用的 Key 已被删除：保留模型 ID 并标记失效，绝不换成另一个 Key。
          {
            modelAlias: projectAlias,
            source: 'project',
            scope: 'project',
            invalidReason: 'credential-missing',
          };
    }
    return {
      modelAlias: projectAlias,
      credentialId: input.activeCredentialId,
      source: 'project',
      scope: 'project',
    };
  }

  const selection = input.globalDefaults[mediaType];
  const alias = modelSelectionAlias(selection);
  if (alias) {
    // 未绑定凭据的类型默认由当前活动凭据提供；显式引用则以该引用为准。
    const referencedCredentialId =
      modelSelectionCredentialId(selection) ?? input.activeCredentialId;
    const credential = findCredential(input.credentials, referencedCredentialId);
    return credential
      ? { modelAlias: alias, credentialId: credential.id, source: 'global', scope: 'global' }
      : {
          modelAlias: alias,
          source: 'global',
          scope: 'global',
          invalidReason: 'credential-missing',
        };
  }

  return { source: 'unset' };
}

/**
 * 在凭据清单里找出为某个媒体类型记录过类型默认的连接。
 *
 * 服务端把「连接 × 类型」的默认模型存在凭据自身（`AiCredentialSummary.defaultModels`），
 * 因此这是判断某一行是否绑定到独立连接的唯一依据。按清单顺序返回第一个命中的凭据，
 * 保证同一份数据每次得到相同结果。
 *
 * @param credentials 已保存凭据摘要。
 * @param mediaType 需要查询的媒体类型。
 * @returns 命中的凭据与它记录的默认值；没有记录时返回 undefined。
 */
export function findCredentialDefaultEntry(
  credentials: readonly (KnownCredential & {
    defaultModels?: Partial<Record<MediaType, string | ModelSelection>>;
  })[],
  mediaType: MediaType,
): { credential: KnownCredential; selection: string | ModelSelection } | undefined {
  for (const credential of credentials) {
    const selection = credential.defaultModels?.[mediaType];
    if (modelSelectionAlias(selection)) return { credential, selection: selection! };
  }
  return undefined;
}

/** 四种默认来源的名称，用于说明当前生效层级并对应第 11 节的展示建议。 */
export const mediaDefaultSourceNames: Record<MediaDefaultSource, string> = {
  run: '本次运行显式配置',
  node: '单节点显式配置',
  project: '项目类型默认',
  global: '全局类型默认',
  unset: '未配置',
};

/** 解析优先级说明，顺序与服务端一致，用于界面按需显示当前生效层级。 */
export const mediaDefaultResolutionOrder: readonly MediaDefaultSource[] = [
  'run',
  'node',
  'project',
  'global',
];

/**
 * 生成默认模型的来源标签，覆盖第 11 节建议的「继承自项目/全局/节点独立」三种情形。
 * @param resolved `resolveMediaDefault` 的解析结果。
 * @param options.hasOverride 该行是否写了显式覆盖；为 true 时显示「节点独立」。
 */
export function mediaDefaultSourceLabel(
  resolved: ResolvedMediaDefault,
  options: { hasOverride: boolean },
): string {
  if (options.hasOverride || resolved.source === 'node') return '节点独立';
  if (resolved.source === 'project') return '继承自项目';
  if (resolved.source === 'global') return '继承自全局';
  if (resolved.source === 'run') return '本次运行';
  return '未配置';
}

/**
 * 生成一行来源说明：包含当前生效层级和完整解析顺序，便于解释模型与 Key 为什么生效。
 * @param resolved `resolveMediaDefault` 的解析结果。
 */
export function mediaDefaultSourceHint(resolved: ResolvedMediaDefault): string {
  const order = mediaDefaultResolutionOrder
    .map((source) =>
      source === resolved.source
        ? `【${mediaDefaultSourceNames[source]}】`
        : mediaDefaultSourceNames[source],
    )
    .join(' > ');
  if (resolved.invalidReason === 'credential-missing') {
    return `已失效：引用的 Key 已被删除；${order}`;
  }
  if (resolved.invalidReason === 'model-missing') {
    return `已失效：模型不在该 Key 的目录中；${order}`;
  }
  if (resolved.source === 'unset') {
    return `尚未配置类型默认；解析顺序：${order}`;
  }
  return `当前生效：${mediaDefaultSourceNames[resolved.source]}；解析顺序：${order}`;
}

/**
 * 判断某条模型目录项是否就是当前生效的组合。
 * 模型 ID 与凭据 ID 必须同时匹配，避免同名模型来自不同 Key 时显示错行。
 */
export function isEffectiveModelChoice(
  choice: ModelChoice,
  resolved: ResolvedMediaDefault,
): boolean {
  if (!resolved.modelAlias || choice.value !== resolved.modelAlias) return false;
  if (!resolved.credentialId) return true;
  return choice.credentialId === resolved.credentialId;
}

/**
 * 判断默认模型是否仍可解析；引用的 Key 被删除时返回 false，
 * 界面据此显示失效状态而不是静默改用另一个 Key。
 */
export function defaultModelUsable(
  defaults: Partial<Record<MediaType, string | ModelSelection>>,
  mediaType: MediaType,
  credentials: readonly KnownCredential[],
): boolean {
  const selection = defaults[mediaType];
  const alias = modelSelectionAlias(selection);
  if (!alias) return true;
  const credentialId = modelSelectionCredentialId(selection);
  if (!credentialId) return true;
  return findCredential(credentials, credentialId) !== undefined;
}
