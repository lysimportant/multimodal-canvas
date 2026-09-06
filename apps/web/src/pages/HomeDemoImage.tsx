import { ImageOff } from 'lucide-react';
import { useState } from 'react';

/** 公开演示图片的显示选项；空替代文本用于资源行中的装饰缩略图。 */
type HomeDemoImageProps = {
  /** 图片内容的可访问说明，装饰图传空字符串。 */
  alt: string;
  /** 首屏主图立即加载；非首屏缩略图延迟加载。 */
  priority?: boolean;
};

/** 固定比例的本地示例图片，加载失败后仍保留版面尺寸和可访问说明。 */
export function HomeDemoImage({ alt, priority = false }: HomeDemoImageProps) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <span
      className="mc-home-image-fallback"
      role={alt ? 'img' : undefined}
      aria-label={alt ? `${alt}，暂时无法加载` : undefined}
      aria-hidden={alt ? undefined : true}
    >
      <ImageOff size={22} aria-hidden="true" />
      {alt && <span>演示画面暂不可用</span>}
    </span>
  ) : (
    <img
      src="/demo/field-study-poster.jpg"
      width="960"
      height="540"
      alt={alt}
      loading={priority ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : 'auto'}
      onError={() => setFailed(true)}
    />
  );
}
