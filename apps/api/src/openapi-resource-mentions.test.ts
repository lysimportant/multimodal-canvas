import { describe, expect, it } from 'vitest';

import { openApiDocument } from './openapi';

type OpenApiDocumentShape = {
  paths: Record<string, any>;
  components: {
    parameters: Record<string, any>;
    schemas: Record<string, any>;
    [section: string]: Record<string, any>;
  };
};

const document = openApiDocument as unknown as OpenApiDocumentShape;

function collectComponentRefs(value: unknown, refs = new Set<string>()): Set<string> {
  if (!value || typeof value !== 'object') return refs;
  if (Array.isArray(value)) {
    value.forEach((item) => collectComponentRefs(item, refs));
    return refs;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref' && typeof child === 'string') refs.add(child);
    else collectComponentRefs(child, refs);
  }
  return refs;
}

describe('resource mention OpenAPI contract', () => {
  it('registers every resource mention and workflow import component', () => {
    const expectedSchemas = [
      'ProjectModelDefaults',
      'MentionBinding',
      'PromptMention',
      'PromptTextBlock',
      'PromptBlock',
      'PromptDocument',
      'FrozenPromptMention',
      'ResourceMentionFailureReason',
      'ResourceMentionDiagnostic',
      'WorkflowExportResultReference',
      'WorkflowExport',
      'WorkflowImportRequest',
      'WorkflowImportIssue',
      'WorkflowImportResponse',
      'WorkflowImportError',
    ];

    for (const name of expectedSchemas) {
      expect(document.components.schemas[name], `missing schema ${name}`).toBeDefined();
    }

    for (const ref of collectComponentRefs(document)) {
      const [, section, name] = ref.match(/^#\/components\/(schemas|parameters)\/(.+)$/) ?? [];
      if (!section || !name) continue;
      expect(document.components[section][name], `unresolved component ref ${ref}`).toBeDefined();
    }
  });

  it('describes prompt and run mention fields without exposing media payloads', () => {
    const promptMention = document.components.schemas.PromptMention;
    const frozenMention = document.components.schemas.FrozenPromptMention;
    const nodeData = document.components.schemas.Canvas?.properties?.nodes?.items?.properties;
    const runSchema = document.components.schemas.Run;

    expect(promptMention.required).toEqual(
      expect.arrayContaining(['type', 'mentionId', 'assetId', 'label', 'mediaType']),
    );
    expect(frozenMention.required).toEqual(
      expect.arrayContaining(['mentionId', 'assetId', 'assetVersion', 'mediaType', 'blockOrder']),
    );
    expect(frozenMention.properties.durationSeconds).toEqual({
      type: 'number',
      exclusiveMinimum: 0,
    });
    expect(document.components.schemas.PromptDocument.properties.blocks).toBeDefined();
    expect(nodeData?.data?.properties?.promptDocument).toEqual({
      $ref: '#/components/schemas/PromptDocument',
    });
    expect(runSchema.properties.snapshot.properties.promptMentions).toBeDefined();
    expect(runSchema.properties.result.properties.promptMentions).toBeDefined();
    expect(runSchema.properties.result.properties.simulated).toMatchObject({ type: 'boolean' });

    const diagnostic = document.components.schemas.ResourceMentionDiagnostic;
    expect(diagnostic.properties.code.enum).toContain('RESOURCE_MENTION_PLACEHOLDER');
    expect(JSON.stringify(diagnostic.properties.reason)).toContain('placeholder');

    const diagnosticText = JSON.stringify(document.components.schemas.ResourceMentionDiagnostic);
    expect(diagnosticText).not.toMatch(/contentUrl|signedUrl|apiKey|accessToken|mediaBytes/i);
  });

  it('documents asset search filters and stable pagination metadata', () => {
    const assetList = document.paths['/v1/assets'].get;
    const parameterRefs = assetList.parameters.map(
      (parameter: { $ref?: string }) => parameter.$ref,
    );
    expect(parameterRefs).toEqual(
      expect.arrayContaining([
        '#/components/parameters/AssetProjectId',
        '#/components/parameters/AssetMediaType',
        '#/components/parameters/AssetTags',
        '#/components/parameters/AssetPage',
        '#/components/parameters/AssetPageSize',
      ]),
    );

    const responseSchema = assetList.responses['200'].content['application/json'].schema;
    expect(responseSchema.required).toEqual(
      expect.arrayContaining(['assets', 'total', 'page', 'pageSize']),
    );
    expect(responseSchema.properties.page.minimum).toBe(1);
    expect(responseSchema.properties.pageSize).toMatchObject({ minimum: 1, maximum: 200 });
  });

  it('documents the optional latest asset version compatibility fields', () => {
    const assetSchema = document.components.schemas.Asset;
    expect(assetSchema.properties.latestVersion).toMatchObject({
      type: 'integer',
      minimum: 1,
    });
    expect(assetSchema.properties.metadata).toEqual({
      type: 'object',
      additionalProperties: true,
    });
    expect(assetSchema.required).not.toContain('latestVersion');
  });

  it('uses direct WorkflowExport for import/export and keeps expectedRevision optional', () => {
    const exportSchema =
      document.paths['/v1/projects/{projectId}/export/workflow'].get.responses['200'].content[
        'application/json'
      ].schema;
    expect(exportSchema).toEqual({ $ref: '#/components/schemas/WorkflowExport' });

    const importRoute = document.paths['/v1/projects/{projectId}/import/workflow'].post;
    expect(importRoute.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/WorkflowImportRequest',
    });
    expect(importRoute.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/WorkflowImportResponse',
    });

    const importSchema = document.components.schemas.WorkflowImportRequest;
    expect(importSchema.required).not.toContain('expectedRevision');
    expect(importSchema.properties.expectedRevision).toMatchObject({ type: 'integer', minimum: 0 });
    expect(document.components.schemas.WorkflowExport.properties.modelDefaults).toEqual({
      $ref: '#/components/schemas/ProjectModelDefaults',
    });
  });

  it('documents structured prompt submission on the run endpoint', () => {
    const runRequest =
      document.paths['/v1/nodes/{nodeId}/runs'].post.requestBody.content['application/json'].schema;
    expect(runRequest.properties.promptDocument).toEqual({
      $ref: '#/components/schemas/PromptDocument',
    });
  });
});

describe('独立短视频复刻分析 OpenAPI', () => {
  it('POST、GET 和响应声明同一可选用途，prompt 继续为序列化模板字符串', () => {
    const endpoint = document.paths['/v1/assets/{assetId}/versions/{version}/reverse-prompts'];
    const body = endpoint.post.requestBody.content['application/json'].schema;
    expect(body.properties.purpose).toEqual({ type: 'string', enum: ['video_recreation'] });
    expect(body.required).not.toContain('purpose');
    expect(endpoint.get.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'purpose',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['video_recreation'] },
        }),
      ]),
    );
    const schema = document.components.schemas.ReversePromptAnalysis;
    expect(schema.properties.purpose.enum).toEqual(['video_recreation']);
    expect(schema.required).not.toContain('purpose');
    expect(schema.properties.prompt.type).toBe('string');
    expect(schema.properties.prompt.description).toContain('JSON.stringify(template)');
  });
});

describe('反推冻结凭据的 HTTP 响应合同', () => {
  it('普通和专属 POST/GET 使用同一可选 credentialId 字段且不开放 secret 或内部快照', () => {
    const endpoint = document.paths['/v1/assets/{assetId}/versions/{version}/reverse-prompts'];
    const postSchema =
      endpoint.post.responses['202'].content['application/json'].schema.properties.analysis;
    const getSchema = endpoint.get.responses['200'].content[
      'application/json'
    ].schema.properties.analysis.anyOf.find(
      (schema: { type?: string }) => schema.type === 'object',
    );
    for (const schema of [
      document.components.schemas.ReversePromptAnalysis,
      postSchema,
      getSchema,
    ]) {
      expect(schema).toBeDefined();
      expect(schema.properties.credentialId).toMatchObject({ type: 'string' });
      expect(schema.required).not.toContain('credentialId');
      expect(schema.additionalProperties).toBe(false);
      for (const key of [
        'apiKey',
        'api_key',
        'authorization',
        'baseUrl',
        'credentialVersion',
        'nodeCredentialReferences',
        'snapshot',
        'requestBody',
      ]) {
        expect(schema.properties).not.toHaveProperty(key);
      }
    }
    expect(postSchema).toEqual(document.components.schemas.ReversePromptAnalysis);
    expect(getSchema).toEqual(document.components.schemas.ReversePromptAnalysis);
  });
});
