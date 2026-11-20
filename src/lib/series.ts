import type { Manifest, MirrorState } from "../api";

/**
 * 更新包是否属于和镜像记录不同的序号组（内网同步记录重建后序号会从 1 重新开始）。
 * 必须与 Rust 核心层 `sync::is_foreign_series` 保持一致：
 * 镜像记录没有序号组时，没有序号组的旧包按原序号规则处理，带序号组的包只有序号
 * 不大于已导入序号时才算新的一组；镜像记录已有序号组后，没有序号组的包不再属于它。
 */
export function isForeignSeries(
  state: Pick<MirrorState, "seriesId" | "lastInSeq"> | null | undefined,
  manifest: Pick<Manifest, "seriesId" | "seq">,
): boolean {
  if (!state) return false;
  if (state.seriesId) return state.seriesId !== manifest.seriesId;
  return !!manifest.seriesId && state.lastInSeq > 0 && manifest.seq <= state.lastInSeq;
}
