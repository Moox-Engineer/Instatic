import type { BaseNode, SiteDocument } from '@core/page-tree'
import { selectVisualComponentById } from '@core/page-tree'

/**
 * Walk a render tree from `rootNodeId`, invoking `onNode` for every node that
 * actually renders — page nodes AND nodes inside referenced Visual Component
 * definition trees.
 *
 * A `base.visual-component-ref` descends into its VC's tree (whose node ids are
 * preserved by `instantiateVCAtRef`, so the keys collected here match the
 * synthetic page rendered for that ref) and then continues into the ref's own
 * children (the slot-instance fills, which live in the page tree). A cycle
 * guard keyed on the expanded ref node ids prevents infinite recursion when a
 * VC (transitively) references itself.
 *
 * VC prop substitution: the ref's `propOverrides` are applied onto definition
 * nodes via their `propBindings` BEFORE `onNode` fires, mirroring what
 * `instantiateVCAtRef` does at render time. Without this, loop/media prefetch
 * reads the DEFINITION's props and per-instance parameters (limit, filters,
 * pagination, …) are silently ignored. Each expanded ref gets its own
 * substitution — two refs to one VC may carry different overrides.
 *
 * Single source of truth for "which nodes contribute to a rendered page" so
 * loop-prefetch and media-prefetch can't drift from each other (ISS-022).
 */
export function walkRenderTree(
  nodes: Record<string, BaseNode>,
  rootNodeId: string,
  site: SiteDocument,
  onNode: (node: BaseNode) => void,
): void {
  // Apply a ref's `propOverrides` onto a definition node's bound props —
  // the prefetch-time mirror of the substitution in `instantiateVCAtRef`.
  const applyPropBindings = (
    defNode: BaseNode,
    overrides: Record<string, unknown>,
  ): BaseNode => {
    const bindings = defNode.propBindings
    if (!bindings || Object.keys(bindings).length === 0) return defNode
    const props = { ...defNode.props }
    for (const [propKey, binding] of Object.entries(bindings)) {
      const paramId = (binding as { paramId?: string } | undefined)?.paramId
      if (paramId && overrides[paramId] !== undefined) {
        props[propKey] = overrides[paramId]
      }
    }
    return { ...defNode, props }
  }

  const visit = (
    curNodes: Record<string, BaseNode>,
    nodeId: string,
    seenRefs: ReadonlySet<string>,
  ): void => {
    const node = curNodes[nodeId]
    if (!node) return
    onNode(node)

    if (node.moduleId === 'base.visual-component-ref') {
      const refProps = (node.props ?? {}) as Record<string, unknown>
      const componentId = typeof refProps['componentId'] === 'string' ? refProps['componentId'] : ''
      // Guard keyed on the REF node id: every ref is expanded at most once
      // (breaks VC self-reference cycles) while still letting two refs to the
      // same VC carry different propOverrides.
      if (componentId && !seenRefs.has(nodeId)) {
        const vc = selectVisualComponentById(site, componentId)
        if (vc) {
          const overrides =
            refProps['propOverrides'] && typeof refProps['propOverrides'] === 'object'
              ? (refProps['propOverrides'] as Record<string, unknown>)
              : {}
          const substituted: Record<string, BaseNode> = {}
          for (const [id, defNode] of Object.entries(vc.tree.nodes as Record<string, BaseNode>)) {
            substituted[id] = applyPropBindings(defNode, overrides)
          }
          visit(substituted, vc.tree.rootNodeId, new Set(seenRefs).add(nodeId))
        }
      }
    }

    for (const childId of node.children) visit(curNodes, childId, seenRefs)
  }

  visit(nodes, rootNodeId, new Set())
}
