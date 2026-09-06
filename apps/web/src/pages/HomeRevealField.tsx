/** 隐藏工作流中的静态分支线路，坐标基于 1440 × 740 的首屏画布。 */
const revealConnections = [
  'M-40 108H238L294 164H616L676 224H822',
  'M62 608H354L414 548H656L720 484H842',
  'M-32 348H54V478H204L272 546',
  'M514 0V78H698V102',
  'M698 166V224H838V292H930',
  'M804 130H900V200H1150V248',
  'M742 374H870V334H930',
  'M876 402H916V470H930',
  'M1170 518V556H990V608H850',
  'M1170 518V576',
  'M1228 608H1390V420H1488',
  'M1114 0V94H1336V180H1480',
  'M568 740V650H718V606',
];

/** 仅表现构思与媒体之间的结构关系，不代表实际任务、模型能力或运行状态。 */
const revealNodes = [
  { x: 616, y: 102, width: 188, height: 64, label: 'REFERENCE', accent: '#a2c9b7' },
  { x: 592, y: 342, width: 150, height: 64, label: 'COMPOSITION', accent: '#d9ec99' },
  { x: 742, y: 374, width: 134, height: 56, label: 'DETAIL', accent: '#e1927e' },
  { x: 694, y: 576, width: 156, height: 60, label: 'SEQUENCE', accent: '#a2c9b7' },
];

/**
 * 首页圆形显影区域中的纯装饰工作流图层。
 * 父层负责定位、裁剪和显示时机；本组件无状态、事件监听、业务请求或鼠标图形。
 * 唯一位图复用本地公开演示素材，所有文字为静态结构标签，不表示后台执行结果。
 */
export function HomeRevealField() {
  return (
    <div className="mc-home-reveal-field" aria-hidden="true">
      <svg
        className="mc-home-reveal-scene"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 1440 740"
        preserveAspectRatio="xMidYMid slice"
        width="100%"
        height="100%"
        focusable="false"
      >
        <rect width="1440" height="740" fill="#151b18" />
        <g stroke="#729c88" strokeWidth="0.6" opacity="0.16" fill="none">
          {[96, 216, 336, 456, 576, 696, 816, 936, 1056, 1176, 1296, 1416].map((x) => (
            <path key={`vertical-${x}`} d={`M${x} 0V740`} />
          ))}
          {[78, 170, 262, 354, 446, 538, 630, 722].map((y) => (
            <path key={`horizontal-${y}`} d={`M0 ${y}H1440`} />
          ))}
        </g>
        <g
          className="mc-home-reveal-connections"
          stroke="#79af95"
          strokeWidth="1"
          strokeLinejoin="round"
          opacity="0.58"
          fill="none"
        >
          {revealConnections.map((path) => (
            <path key={path} d={path} />
          ))}
        </g>
        <g stroke="#557363" strokeWidth="0.7" fill="none" opacity="0.32">
          <path d="M22 692H306L352 646H504V570" />
          <path d="M318 18V52H556V144" />
          <path d="M1324 740V680H1126V652H976" />
          <path d="M1280 216H1416V312" />
        </g>
        <g className="mc-home-reveal-nodes">
          {revealNodes.map(({ x, y, width, height, label, accent }) => (
            <g key={label} transform={`translate(${x} ${y})`}>
              <rect width={width} height={height} rx="4" fill="#1b2721" stroke="#577965" />
              <rect x="12" y="14" width="4" height="4" fill={accent} />
              <text
                x="26"
                y="19"
                fill="#b5cfbe"
                fontFamily="ui-monospace, SFMono-Regular, Consolas, monospace"
                fontSize="9"
                letterSpacing="0"
              >
                {label}
              </text>
              <path d={`M12 33H${width - 12}`} stroke="#3e584a" strokeWidth="0.7" />
              <path
                d={`M12 ${height - 14}H${width * 0.48}`}
                stroke={accent}
                strokeWidth="1"
                opacity="0.6"
              />
              <circle cx={width / 2} cy={height} r="2.5" fill="#151b18" stroke={accent} />
            </g>
          ))}
        </g>
        <image
          className="mc-home-reveal-image"
          href="/demo/field-study-poster.jpg"
          x="930"
          y="248"
          width="480"
          height="270"
          preserveAspectRatio="xMidYMid meet"
          opacity="0.88"
        />
        <g stroke="#a0c4ae" strokeWidth="1" fill="none" opacity="0.75">
          <path d="M948 242H924V266M1392 242H1416V266M924 500V524H948M1392 524H1416V500" />
          <path d="M1032 278H1098V312M1032 278V334" opacity="0.45" />
          <path d="M1298 422V478H1242" opacity="0.45" />
        </g>
        <image
          className="mc-home-reveal-image mc-home-reveal-image-detail"
          href="/demo/field-study-poster.jpg"
          x="1110"
          y="576"
          width="118"
          height="66.375"
          preserveAspectRatio="xMidYMid meet"
          opacity="0.75"
        />
        <g fill="#d9ec99">
          <rect x="612" y="220" width="5" height="5" />
          <rect x="986" y="552" width="5" height="5" />
        </g>
        <g fill="#e1927e">
          <rect x="350" y="604" width="4" height="4" />
          <rect x="1332" y="90" width="4" height="4" />
        </g>
        <g stroke="#a2c9b7" fill="#151b18" strokeWidth="1">
          <circle cx="838" cy="224" r="3" />
          <circle cx="870" cy="374" r="3" />
          <circle cx="1170" cy="556" r="3" />
        </g>
      </svg>
    </div>
  );
}
