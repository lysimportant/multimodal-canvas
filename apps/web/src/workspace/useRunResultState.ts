import { useEffect, useMemo, useState } from 'react';

import type { Asset, RunRecord, RunResultAsset } from '@multimodal-canvas/domain';
import { apiFetch } from '../auth-client';
import type { AssetFlowNode } from '../canvas-utils';
import { fetchAssetVersions, type AssetVersionSummary } from '../result-versions';
import { API_BASE_URL } from './contracts';

export type RunResultState = {
  resultAsset?: RunResultAsset;
  versions: AssetVersionSummary[];
  versionsLoading: boolean;
  versionsError: string | null;
  currentVersion: number;
  currentContentUrl?: string;
  currentPreviewAsset: Asset;
};

export function useRunResultState(
  selectedNode: AssetFlowNode | null,
  selectedRun?: RunRecord,
): RunResultState {
  const [versions, setVersions] = useState<AssetVersionSummary[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const resultAsset = selectedRun?.result?.asset;
  const resultAssetId = resultAsset?.assetId;
  const resultVersion = resultAsset?.version;

  useEffect(() => {
    let active = true;
    if (!resultAssetId) {
      setVersions([]);
      setVersionsLoading(false);
      setVersionsError(null);
      return () => {
        active = false;
      };
    }

    setVersions([]);
    setVersionsLoading(true);
    setVersionsError(null);
    void fetchAssetVersions(resultAssetId, API_BASE_URL, apiFetch).then(
      (nextVersions) => {
        if (!active) return;
        setVersions(nextVersions);
        setVersionsLoading(false);
      },
      (error: unknown) => {
        if (!active) return;
        setVersions([]);
        setVersionsLoading(false);
        setVersionsError(error instanceof Error ? error.message : '结果版本加载失败');
      },
    );
    return () => {
      active = false;
    };
  }, [resultAssetId, resultVersion]);

  const currentVersion = resultAsset?.version ?? versions[versions.length - 1]?.version ?? 1;
  const currentVersionRecord = versions.find((version) => version.version === currentVersion);
  const currentContentUrl = currentVersionRecord?.contentUrl ?? resultAsset?.contentUrl;
  const currentPreviewAsset = useMemo<Asset>(
    () => ({
      id: resultAsset?.assetId ?? currentVersionRecord?.assetId ?? 'result',
      name: `${selectedNode?.data.label ?? '节点'}结果`,
      mediaType: selectedNode?.data.mediaType ?? 'text',
      mimeType: resultAsset?.mimeType ?? selectedNode?.data.mimeType ?? 'application/octet-stream',
      sizeBytes: resultAsset?.sizeBytes ?? currentVersionRecord?.sizeBytes ?? 0,
      status: 'ready',
      contentUrl: currentContentUrl ?? '',
      tags: [],
    }),
    [
      currentContentUrl,
      currentVersionRecord?.assetId,
      currentVersionRecord?.sizeBytes,
      resultAsset?.assetId,
      resultAsset?.mimeType,
      resultAsset?.sizeBytes,
      selectedNode?.data.label,
      selectedNode?.data.mediaType,
      selectedNode?.data.mimeType,
    ],
  );

  return {
    resultAsset,
    versions,
    versionsLoading,
    versionsError,
    currentVersion,
    currentContentUrl,
    currentPreviewAsset,
  };
}
