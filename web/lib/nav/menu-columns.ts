/** Keep sections in their configured order while balancing two independent stacks. */
export function menuColumns<T>(blocks: readonly T[], weight: (block: T) => number): T[][] {
  if (blocks.length < 2) return [[...blocks]]
  const total = blocks.reduce((sum, block) => sum + weight(block), 0)
  let left = 0
  let split = 1
  let imbalance = Infinity
  for (let index = 1; index < blocks.length; index += 1) {
    left += weight(blocks[index - 1]!)
    const next = Math.abs(total - left * 2)
    // Equally balanced splits keep the additional section in the left stack.
    if (next <= imbalance) { split = index; imbalance = next }
  }
  return [blocks.slice(0, split), blocks.slice(split)]
}
