/** Order strongly connected dependency groups without discarding their outgoing edges.
 * Row-level constraints remain authoritative within each structural cycle. */
export function orderDependencyComponents(
  names: readonly string[],
  edges: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const order: string[] = [];
  let nextIndex = 0;
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const visit = (node: string) => {
    index.set(node, nextIndex);
    lowLink.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);
    for (const child of edges.get(node) ?? []) {
      if (!index.has(child)) {
        visit(child);
        lowLink.set(node, Math.min(lowLink.get(node)!, lowLink.get(child)!));
      } else if (onStack.has(child)) {
        lowLink.set(node, Math.min(lowLink.get(node)!, index.get(child)!));
      }
    }
    if (lowLink.get(node) === index.get(node)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      components.push(component);
    }
  };
  for (const n of names) if (!index.has(n)) visit(n);
  const componentFor = new Map<string, number>();
  components.forEach((members, component) => members.forEach((member) => componentFor.set(member, component)));
  const componentChildren = new Map(components.map((_, component) => [component, new Set<number>()]));
  const componentIndeg = new Map(components.map((_, component) => [component, 0]));
  for (const [parent, childrenForParent] of edges) {
    for (const child of childrenForParent) {
      const parentComponent = componentFor.get(parent)!;
      const childComponent = componentFor.get(child)!;
      if (parentComponent === childComponent || componentChildren.get(parentComponent)!.has(childComponent)) continue;
      componentChildren.get(parentComponent)!.add(childComponent);
      componentIndeg.set(childComponent, componentIndeg.get(childComponent)! + 1);
    }
  }
  const componentOrder = (component: number) => Math.min(...components[component]!.map((n) => names.indexOf(n)));
  const componentQueue = components.map((_, component) => component)
    .filter((component) => componentIndeg.get(component) === 0)
    .sort((a, b) => componentOrder(a) - componentOrder(b));
  while (componentQueue.length) {
    const component = componentQueue.shift()!;
    order.push(...components[component]!.sort((a, b) => names.indexOf(a) - names.indexOf(b)));
    for (const child of componentChildren.get(component) ?? []) {
      componentIndeg.set(child, componentIndeg.get(child)! - 1);
      if (componentIndeg.get(child) === 0) {
        componentQueue.push(child);
        componentQueue.sort((a, b) => componentOrder(a) - componentOrder(b));
      }
    }
  }
  return order;
}
