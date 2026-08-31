import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FailureDiagnosticsRun } from './FailureDiagnostics';
import { FailureDiagnostics, getFailureDiagnosticDetails } from './FailureDiagnostics';

function syntheticApiKey(...segments: string[]): string {
  return [['s', 'k'].join(''), ...segments].join('-');
}

function makeRun(overrides: Record<string, unknown> = {}): FailureDiagnosticsRun {
  return {
    id: 'run_failure_1',
    projectId: 'project_1',
    targetNodeId: 'node_1',
    status: 'failed',
    progress: 82,
    attempt: 1,
    provider: 'newapi',
    modelAlias: 'text-model',
    snapshot: {} as FailureDiagnosticsRun['snapshot'],
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:01:00.000Z',
    ...overrides,
  } as FailureDiagnosticsRun;
}

describe('FailureDiagnostics', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows safe error details and extracts provider diagnostics', () => {
    const unsafeApiKey = syntheticApiKey('super', 'secret', 'value');
    const run = makeRun({
      error: `gateway rejected request apiKey=${unsafeApiKey}`,
      errorCode: 'rate_limit',
      requestId: 'req-top-level',
      retryable: true,
      providerJob: {
        id: 'job_1',
        provider: 'newapi',
        platformJobId: 'platform_123',
        status: 'failed',
        progress: 82,
        payload: {
          requestId: 'req-provider',
          retryable: false,
          statusResponse: { requestId: 'req-status', code: 'ignored_code' },
        },
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:01:00.000Z',
      },
    });

    render(<FailureDiagnostics run={run} />);

    expect(screen.getByTestId('failure-diagnostics')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('apiKey=[已隐藏]');
    expect(screen.getByRole('alert')).not.toHaveTextContent(unsafeApiKey);
    expect(screen.getByText('rate_limit')).toBeInTheDocument();
    expect(screen.getByText('req-top-level')).toBeInTheDocument();
    expect(screen.getByText('platform_123')).toBeInTheDocument();
    expect(screen.getByText('可重试')).toBeInTheDocument();
  });

  it('supports retry and keeps the action busy while the callback is pending', async () => {
    let resolveRetry!: () => void;
    const onRetry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRetry = resolve;
        }),
    );
    render(<FailureDiagnostics run={makeRun({ retryable: true })} onRetry={onRetry} />);

    const button = screen.getByRole('button', { name: '重试' });
    fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '重试中' })).toBeDisabled();

    resolveRetry();
    await waitFor(() => expect(screen.getByRole('button', { name: '重试' })).toBeEnabled());
  });

  it('does not offer retry when the provider marks a run non-retryable', () => {
    const run = makeRun({
      providerJob: {
        payload: { retryable: false, error: 'invalid model' },
      },
    });
    render(<FailureDiagnostics run={run} onRetry={vi.fn()} />);

    expect(screen.getByText('不可重试')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
    expect(screen.getByText(/不可重试，请检查模型和输入/)).toBeInTheDocument();
  });

  it('surfaces a safe retry error and hides itself for non-failure runs without errors', async () => {
    const unsafeRetryToken = syntheticApiKey('sensitive');
    const onRetry = vi.fn().mockRejectedValue(new Error(`token=${unsafeRetryToken} failed`));
    const view = render(
      <FailureDiagnostics run={makeRun({ retryable: true })} onRetry={onRetry} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    await waitFor(() =>
      expect(screen.getByText(/重试提交失败|token=\[已隐藏\]/)).toBeInTheDocument(),
    );
    expect(screen.getByTestId('failure-diagnostics')).not.toHaveTextContent(unsafeRetryToken);

    view.rerender(<FailureDiagnostics run={makeRun({ status: 'running', error: undefined })} />);
    expect(screen.queryByTestId('failure-diagnostics')).not.toBeInTheDocument();
  });

  it('supports top-level aliases without exposing credential-shaped identifiers', () => {
    const unsafeProviderJobId = syntheticApiKey('platform', 'secret');
    const run = makeRun({
      status: 'cancelled',
      providerJobId: unsafeProviderJobId,
      requestId: 'request-safe',
      retryable: false,
    });
    expect(getFailureDiagnosticDetails(run)).toMatchObject({
      requestId: 'request-safe',
      retryable: false,
    });
    expect(getFailureDiagnosticDetails(run).platformJobId).toBeUndefined();
  });
});
