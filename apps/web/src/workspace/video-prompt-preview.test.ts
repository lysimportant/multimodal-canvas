import { describe, expect, it } from 'vitest';
import type {
  PromptDocument,
  PromptMention,
  VideoReferenceCapability,
} from '@multimodal-canvas/domain';
import { previewVideoPrompt } from './video-prompt-preview';

const image: PromptMention = {
  type: 'mention',
  mentionId: 'hero',
  assetId: 'hero',
  assetVersion: 2,
  label: 'hero.png',
  mediaType: 'image',
  inline: true,
};
const context = { modelAlias: 'wan3.0-video', videoMode: 'omni_reference' as const };
const videoReferences: VideoReferenceCapability = {
  version: 1,
  adapter: 'seedance-video',
  maxImages: 30,
  maxVideos: 10,
  maxAudios: 10,
  tokenSyntax: 'numbered-media',
};

describe('视频输入正文预览', () => {
  it.each(['arbitrary-channel-alias', 'doubao-seedance-2-0-260128', 'wan3.0-video', 'minimax-h3'])(
    '有渠道契约时 %s 优先使用统一编号，分别编号图片、视频和音频',
    (modelAlias) => {
      expect(
        previewVideoPrompt(
          {
            version: 1,
            blocks: [
              image,
              { type: 'text', text: ' / ' },
              { ...image, assetId: 'motion', mentionId: 'motion', mediaType: 'video' },
              { type: 'text', text: ' / ' },
              { ...image, assetId: 'voice', mentionId: 'voice', mediaType: 'audio' },
            ],
          },
          { ...context, modelAlias, videoReferences },
        ),
      ).toBe('Image 1 / Video 1 / Audio 1');
    },
  );

  it('渠道契约保留资源顺序、不同版本身份和重复引用去重', () => {
    expect(
      previewVideoPrompt(
        {
          version: 1,
          blocks: [
            image,
            { type: 'text', text: '/' },
            { ...image, mentionId: 'again' },
            { type: 'text', text: '/' },
            { ...image, assetVersion: 1, mentionId: 'older' },
          ],
        },
        {
          ...context,
          modelAlias: 'arbitrary',
          videoReferences: { ...videoReferences, maxImages: 2 },
        },
        [],
        [
          {
            id: 'ordered:older',
            assetId: 'hero',
            assetVersion: 1,
            mediaType: 'image',
            name: '旧版',
          },
          {
            id: 'ordered:current',
            assetId: 'hero',
            assetVersion: 2,
            mediaType: 'image',
            name: '当前版',
          },
        ],
      ),
    ).toBe('Image 2/Image 2/Image 1');
  });

  it.each([
    ['image', 'maxImages', '图片'],
    ['video', 'maxVideos', '视频'],
    ['audio', 'maxAudios', '音频'],
  ] as const)('按真实发送的 %s 数量检查上限', (mediaType, limitKey, label) => {
    const limited = { ...context, videoReferences: { ...videoReferences, [limitKey]: 1 } };
    const document: PromptDocument = {
      version: 1,
      blocks: [
        { ...image, mediaType },
        { ...image, mediaType, mentionId: 'repeat' },
      ],
    };
    expect(() => previewVideoPrompt(document, limited)).not.toThrow();
    expect(() =>
      previewVideoPrompt(
        document,
        limited,
        [],
        [
          {
            id: 'attached:extra',
            assetId: 'extra',
            assetVersion: 1,
            mediaType,
            name: '额外素材',
            attached: true,
          },
        ],
      ),
    ).toThrow(`最多支持 1 个${label}参考素材，当前为 2 个`);
  });

  it.each(['start_frame', 'end_frame'])('禁止与未追踪的 %s 素材混用', (key) => {
    for (const parameters of [{ [key]: 'synthetic' }, { metadata: { [key]: 'synthetic' } }]) {
      expect(() =>
        previewVideoPrompt(
          { version: 1, blocks: [image] },
          {
            ...context,
            videoReferences,
            parameters,
          },
        ),
      ).toThrow('混用');
    }
  });

  it('渠道契约即使没有内联正文也拒绝未追踪媒体参数', () => {
    expect(() =>
      previewVideoPrompt(
        { version: 1, blocks: [{ type: 'text', text: '运动镜头' }] },
        {
          ...context,
          videoReferences,
          parameters: { start_frame: 'synthetic' },
        },
      ),
    ).toThrow('混用');
  });

  it.each([
    ['doubao-seedance-2-0-260128', '图 1'],
    ['wan3.0-video', '图1'],
    ['minimax-h3', '<Picture 1>'],
  ])('按 %s 转换实际素材标记，保留普通文字和空白', (modelAlias, token) => {
    expect(
      previewVideoPrompt(
        {
          version: 1,
          blocks: [{ type: 'text', text: ' 开场\n' }, image, { type: 'text', text: '向前走。 ' }],
        },
        { ...context, modelAlias },
      ),
    ).toBe(` 开场\n${token}向前走。 `);
  });

  it('资源条重排改变编号，同版本重复引用复用编号，附加资源不进入正文', () => {
    const document: PromptDocument = {
      version: 1,
      blocks: [
        image,
        { type: 'text', text: '和' },
        { ...image, mentionId: 'again' },
        { type: 'text', text: '2人对话' },
      ],
    };
    const before = structuredClone(document);
    expect(
      previewVideoPrompt(
        document,
        context,
        [],
        [
          {
            id: 'attached:background',
            attached: true,
            assetId: 'background',
            assetVersion: 1,
            mediaType: 'image',
            name: '背景',
          },
          {
            id: 'ordered:hero',
            assetId: 'hero',
            assetVersion: 2,
            mediaType: 'image',
            name: '主角',
          },
        ],
      ),
    ).toBe('图2和图2 2人对话');
    expect(document).toEqual(before);
  });

  it('连线素材先占编号，保留当前引用实体名', () => {
    expect(
      previewVideoPrompt({ version: 1, blocks: [{ ...image, entityName: '主角' }] }, context, [
        {
          id: 'scene',
          name: '场景',
          mediaType: 'image',
          assetVersion: 1,
          videoInputBindings: [{ nodeId: 'scene-node', role: 'referenceImage', sortOrder: 0 }],
        },
      ]),
    ).toBe('图2（主角）');
  });

  it('缺少版本、占位资源和未知模型不产生虚假提交正文', () => {
    const doc = (mention: PromptMention): PromptDocument => ({ version: 1, blocks: [mention] });
    expect(() => previewVideoPrompt(doc({ ...image, assetVersion: undefined }), context)).toThrow(
      '版本尚未确定',
    );
    expect(() => previewVideoPrompt(doc({ ...image, placeholder: true }), context)).toThrow(
      '尚未绑定',
    );
    expect(() => previewVideoPrompt(doc(image), { ...context, modelAlias: 'unknown' })).toThrow(
      '尚未确认',
    );
    expect(() =>
      previewVideoPrompt(doc(image), { ...context, parameters: { images: ['synthetic'] } }),
    ).toThrow('混用');
  });
});
