import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { AudioLines, LoaderCircle, Pause, Play, Repeat2, RotateCcw } from 'lucide-react';

import { Button } from '@multimodal-canvas/ui';
import './media-preview-player.css';

/** Dialog 与公开分享的播放输入；组件只操作当前媒体元素，不读取账号或改写资源。 */
export type MediaPreviewPlayerProps = {
  kind: 'video' | 'audio';
  src: string;
  name: string;
  /** 仅显式打开的 Dialog 启用自动播放；公开分享默认等待用户点击。 */
  autoPlay?: boolean;
  /** 分享页面保持跨域匿名读取，私有预览保持已有地址的访问方式。 */
  crossOrigin?: 'anonymous';
  className?: string;
  /** 解码失败时通知父页面；分享页据此重新验证链接有效性。 */
  onError?: () => void;
  /** 解码尺寸交给 Dialog 的适配算法，不改变节点外框。 */
  onLoadedMetadata?: (event: SyntheticEvent<HTMLVideoElement | HTMLAudioElement>) => void;
  /** Dialog 将媒体放入可缩放舞台，播放工具栏仍在舞台外，避免被缩放或裁切。 */
  renderMedia?: (media: ReactNode) => ReactNode;
};

/**
 * 提供明确的播放操作、倍速与循环；进度、音量和视频全屏使用浏览器原生控件。
 * 切换源、重试和卸载时停止旧媒体；迟到的播放拒绝不会更新新资源状态。
 * @param props 已验证的媒体地址、展示名称及可选 Dialog 布局回调。
 * @returns 媒体舞台、播放工具栏与可重试的错误提示，不发起生成或授权请求。
 */
export function MediaPreviewPlayer({ src, kind, ...props }: MediaPreviewPlayerProps) {
  // 同一个播放器切换地址或媒体类型时，重建本地播放状态与元素。
  return <MediaPlayerSession key={`${kind}:${src}`} {...props} kind={kind} src={src} />;
}

/** 单份媒体的播放状态；资源身份由外层 key 隔离，重试保留用户选择的倍速与循环。 */
function MediaPlayerSession({
  kind,
  src,
  name,
  autoPlay = false,
  crossOrigin,
  className = '',
  onError,
  onLoadedMetadata,
  renderMedia,
}: MediaPreviewPlayerProps) {
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement>(null);
  const requestId = useRef(0);
  const [attempt, setAttempt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [ready, setReady] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string>();
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState(false);
  const label = kind === 'video' ? '视频' : '音频';

  useEffect(() => {
    const media = mediaRef.current;
    return () => {
      requestId.current += 1;
      media?.pause();
    };
  }, [attempt]);

  /** 播放成功由媒体事件确认；策略或解码器拒绝时显示原因，不伪装成播放中。 */
  const togglePlayback = async () => {
    const media = mediaRef.current;
    if (!media || failed) return;
    const identity = ++requestId.current;
    setError(undefined);
    if (!media.paused && !media.ended) {
      media.pause();
      return;
    }
    if (media.ended) media.currentTime = 0;
    try {
      await media.play();
    } catch (reason) {
      if (requestId.current !== identity || mediaRef.current !== media) return;
      setWaiting(false);
      setError(
        `${label}播放失败：${reason instanceof Error ? reason.message : '浏览器未能开始播放'}。请重试。`,
      );
    }
  };

  const attributes = {
    src,
    controls: true,
    autoPlay,
    crossOrigin,
    loop,
    preload: 'metadata' as const,
    'aria-label': name,
    onLoadedMetadata: (event: SyntheticEvent<HTMLVideoElement | HTMLAudioElement>) => {
      setReady(true);
      event.currentTarget.playbackRate = rate;
      onLoadedMetadata?.(event);
    },
    onPlay: () => {
      setPlaying(true);
      setEnded(false);
      setError(undefined);
    },
    onPlaying: () => setWaiting(false),
    onWaiting: () => setWaiting(true),
    onCanPlay: () => setWaiting(false),
    onPause: () => {
      setPlaying(false);
      setWaiting(false);
    },
    onEnded: () => {
      setPlaying(false);
      setEnded(true);
    },
    onRateChange: (event: SyntheticEvent<HTMLVideoElement | HTMLAudioElement>) =>
      setRate(event.currentTarget.playbackRate),
    onError: () => {
      requestId.current += 1;
      setFailed(true);
      setPlaying(false);
      setWaiting(false);
      setError(`${label}加载失败，请重新加载预览`);
      onError?.();
    },
  };
  const media = (
    <div className={`media-preview-player-stage is-${kind}`}>
      {kind === 'video' ? (
        <video
          key={attempt}
          ref={(element) => {
            mediaRef.current = element;
          }}
          {...attributes}
          playsInline
        />
      ) : (
        <>
          <AudioLines size={44} aria-hidden="true" className="media-preview-player-audio-icon" />
          <audio
            key={attempt}
            ref={(element) => {
              mediaRef.current = element;
            }}
            {...attributes}
          />
        </>
      )}
      {kind === 'video' && ready && !playing && !failed && (
        <Button
          type="button"
          className="media-preview-player-overlay"
          aria-label={ended ? '重播视频' : '播放视频'}
          onClick={() => void togglePlayback()}
        >
          {ended ? (
            <RotateCcw size={28} aria-hidden="true" />
          ) : (
            <Play size={28} aria-hidden="true" />
          )}
        </Button>
      )}
    </div>
  );

  return (
    <div className={`media-preview-player ${className}`}>
      {renderMedia ? renderMedia(media) : media}
      <div className="media-preview-player-tools" role="group" aria-label={`${label}播放控制`}>
        <Button
          type="button"
          aria-label={`${playing ? '暂停' : ended ? '重播' : '播放'}${label}`}
          disabled={failed}
          onClick={() => void togglePlayback()}
        >
          {playing ? (
            <Pause size={16} aria-hidden="true" />
          ) : ended ? (
            <RotateCcw size={16} aria-hidden="true" />
          ) : (
            <Play size={16} aria-hidden="true" />
          )}
          {playing ? '暂停' : ended ? '重播' : '播放'}
        </Button>
        <label>
          倍速
          <select
            aria-label="播放速度"
            value={rate}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (mediaRef.current) mediaRef.current.playbackRate = value;
              setRate(value);
            }}
          >
            {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((value) => (
              <option key={value} value={value}>
                {value}×
              </option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          aria-label="循环播放"
          aria-pressed={loop}
          onClick={() => setLoop((value) => !value)}
        >
          <Repeat2 size={16} aria-hidden="true" />
          循环
        </Button>
        {!failed && (!ready || waiting) && (
          <span role="status">
            <LoaderCircle size={14} className="spin" aria-hidden="true" />
            {ready ? '正在缓冲…' : '正在加载…'}
          </span>
        )}
        {error && (
          <span className="media-preview-player-error" role="alert">
            {error}
          </span>
        )}
        {failed && (
          <Button
            type="button"
            onClick={() => {
              setReady(false);
              setFailed(false);
              setEnded(false);
              setError(undefined);
              setAttempt((value) => value + 1);
            }}
          >
            重新加载预览
          </Button>
        )}
      </div>
    </div>
  );
}
