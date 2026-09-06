import { RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { HomeDemoImage } from './HomeDemoImage';

/** 提供真实原生媒体控制，离屏和后台暂停，解码失败时保留可查看的参考画面。 */
export function HomeDemoMedia() {
  const videoRef = useRef<HTMLVideoElement>(null);
  /** 仅记录媒体自身的加载或解码错误，不将暂停误报为故障。 */
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    /** 只暂停，不自动恢复，避免回到页面时意外有声播放。 */
    const pauseWhenHidden = () => {
      if (document.hidden) video.pause();
    };
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(
            ([entry]) => {
              if (!entry.isIntersecting) video.pause();
            },
            { threshold: 0.1 },
          );
    observer?.observe(video);
    document.addEventListener('visibilitychange', pauseWhenHidden);
    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', pauseWhenHidden);
      if (!video.paused) video.pause();
    };
  }, [failed]);
  return (
    <figure className="mc-home-demo-media">
      {failed ? (
        <div className="mc-home-media-fallback">
          <HomeDemoImage alt="自然观察视频的参考画面" priority />
          <div>
            <span role="status">视频暂时无法播放</span>
            <button type="button" onClick={() => setFailed(false)}>
              <RefreshCw size={15} aria-hidden="true" /> 重试
            </button>
          </div>
        </div>
      ) : (
        <video
          ref={videoRef}
          aria-label="自然观察演示视频"
          controls
          muted
          playsInline
          preload="metadata"
          poster="/demo/field-study-poster.jpg"
          src="/demo/field-study.mp4"
          width="960"
          height="540"
          onError={() => setFailed(true)}
        />
      )}
      <figcaption>
        <span>FIELD STUDY / 01</span>
        <span>960 × 540 · 5 秒</span>
      </figcaption>
    </figure>
  );
}
