/** Counts for a native page, including bounded readers whose total is unknown. */
export function paginationWindow({total,page,perPage,loadedCount,hasMore=false}: {total:number|null;page:number;perPage:number;loadedCount?:number;hasMore?:boolean}) {
  const unknownTotal = total === null
  if (unknownTotal && (!Number.isSafeInteger(loadedCount) || loadedCount! < 0 || loadedCount! > perPage || !Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(perPage) || perPage < 1 || !Number.isSafeInteger((page-1)*perPage+1))) throw new Error('Unknown-total pagination requires a valid page, page size and loaded row count.')
  const visibleCount = unknownTotal ? loadedCount! : total
  const pageCount = unknownTotal ? page + (hasMore ? 1 : 0) : Math.max(1,Math.ceil(total/perPage))
  const from = visibleCount === 0 ? 0 : (page-1)*perPage+1
  return {unknownTotal,visibleCount,pageCount,from,to:unknownTotal ? visibleCount === 0 ? 0 : from+visibleCount-1 : Math.min(total,page*perPage),isOutOfRange:!unknownTotal && total>0 && page>pageCount}
}
