// utils/virtualist.ts
// Dependency-free virtual list manager for rendering large lists efficiently.
// Computes visible item indices and offsets for a given scroll position.
//
// Usage example (React-like pseudo):
//   const vlist = createVirtualList({ itemCount: 10000, itemHeight: 30, viewportHeight: 600 });
//   vlist.scrollTo(2000); // simulate scrollTop
//   const { start, end, offsetTop } = vlist.getVisibleRange();
//   const items = data.slice(start, end + 1);
//   render(<div style={{ paddingTop: offsetTop, paddingBottom: vlist.bottomSpacer(end) }}>{items}</div>)

export interface VirtualListOptions {
  itemCount: number;            // total number of items
  itemHeight: number | ((i: number) => number); // fixed or variable height
  viewportHeight: number;       // visible window height
  overscan?: number;            // number of extra items above/below viewport
}

export interface VisibleRange {
  start: number;
  end: number;
  offsetTop: number;
  offsetBottom: number;
}

export interface VirtualList {
  scrollTo(scrollTop: number): void;
  getVisibleRange(): VisibleRange;
  totalHeight(): number;
  update(opts: Partial<VirtualListOptions>): void;
}

export function createVirtualList(opts: VirtualListOptions): VirtualList {
  let { itemCount, itemHeight, viewportHeight, overscan = 2 } = opts;
  let scrollTop = 0;

  const heights: number[] = [];
  const prefixSum: number[] = [0];

  const isFixed = typeof itemHeight === "number";
  const fixedHeight = isFixed ? (itemHeight as number) : 0;

  if (!isFixed) {
    for (let i = 0; i < itemCount; i++) {
      const h = (itemHeight as (i: number) => number)(i);
      heights[i] = h;
      prefixSum[i + 1] = prefixSum[i] + h;
    }
  }

  function totalHeight(): number {
    return isFixed ? fixedHeight * itemCount : prefixSum[itemCount];
  }

  function findIndex(offset: number): number {
    if (isFixed) {
      return Math.floor(offset / fixedHeight);
    }
    // binary search on prefixSum
    let lo = 0, hi = itemCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (prefixSum[mid] <= offset) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(0, lo - 1);
  }

  function getVisibleRange(): VisibleRange {
    const maxScroll = Math.max(0, totalHeight() - viewportHeight);
    const st = clamp(scrollTop, 0, maxScroll);

    const startIdx = findIndex(st);
    const startOffset = isFixed ? startIdx * fixedHeight : prefixSum[startIdx];

    const viewportEnd = st + viewportHeight;
    let endIdx: number;
    if (isFixed) {
      endIdx = Math.min(itemCount - 1, Math.floor(viewportEnd / fixedHeight));
    } else {
      endIdx = findIndex(viewportEnd);
      if (endIdx < itemCount - 1) endIdx++;
    }

    const start = Math.max(0, startIdx - overscan);
    const end = Math.min(itemCount - 1, endIdx + overscan);

    const offsetTop = isFixed
      ? start * fixedHeight
      : prefixSum[start];
    const offsetBottom = totalHeight() - (isFixed ? (end + 1) * fixedHeight : prefixSum[end + 1]);

    return { start, end, offsetTop, offsetBottom };
  }

  function scrollTo(st: number) {
    scrollTop = st;
  }

  function update(newOpts: Partial<VirtualListOptions>) {
    if (newOpts.itemCount !== undefined) itemCount = newOpts.itemCount;
    if (newOpts.viewportHeight !== undefined) viewportHeight = newOpts.viewportHeight;
    if (newOpts.overscan !== undefined) overscan = newOpts.overscan;
    if (newOpts.itemHeight !== undefined) {
      itemHeight = newOpts.itemHeight;
      if (typeof itemHeight === "number") {
        // fixed
      } else {
        // recompute prefix sums
        heights.length = 0;
        prefixSum.length = 1;
        prefixSum[0] = 0;
        for (let i = 0; i < itemCount; i++) {
          const h = (itemHeight as (i: number) => number)(i);
          heights[i] = h;
          prefixSum[i + 1] = prefixSum[i] + h;
        }
      }
    }
  }

  return {
    scrollTo,
    getVisibleRange,
    totalHeight,
    update,
  };
}

// helper
function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}
// bottom spacer height for rendering