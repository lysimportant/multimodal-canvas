/** 沿用 New API 广场的倍率、Token 单位和分组规则。 */
export const FILTER_ALL = 'all';
/** 自动路由不作为单独可选计费分组。 */
export const EXCLUDED_GROUPS = ['', 'auto'];
/** 0 为 Token，1 为按次；动态表达式另外由原解析器识别。 */
export const QUOTA_TYPE_VALUES = { TOKEN: 0, REQUEST: 1 } as const;
/** 原单价以百万 Token 计价。 */
export const TOKEN_UNIT_DIVISORS = { M: 1, K: 1000 } as const;
