/**
 * `/_instatic/loop/<loopId>` endpoint — serves additional pages for
 * infinite-loading loops.
 *
 * Called by the loop runtime (`loopRuntime.ts`) after the user clicks
 * "Load more". Returns `{ html, hasMore, pageNumber }` JSON.
 *
 * Algorithm:
 *   1. Resolve the page from the request's `pagePath` query param via
 *      the same routing logic the public renderer uses.
 *   2. Find the loop node by id within the resolved page.
 *   3. Run the loop's source `fetch()` for the requested page slice.
 *   4. Render only the loop's children using a synthetic page context
 *      sharing the publisher's renderNode walker.
 *   5. Return the joined HTML — clients append it before the load-more
 *      button.
 *
 * This handler is GET-only and returns 404 for any combination that
 * doesn't resolve cleanly. Errors are rendered as 4xx/5xx with empty
 * bodies; the runtime's "Try again" UX surfaces network failures.
 */

import type { DbClient } from '../../db/client'
import type { Page, PageNode } from '@core/page-tree'
import { registry } from '@core/module-engine'
import { loopSourceRegistry } from '@core/loops/registry'
import {
  renderNode,
  type RenderConfig,
  type RenderAccumulators,
  type ResolvedLoopRenderData,
} from '@core/publisher'
import { selectVisualComponentById } from '@core/page-tree'
import { jsonResponse } from '../../http'
import { readLoopProps } from '../../publish/loopPrefetch'
import { getPublishedLoopIndexForVersion } from '../../publish/publishedSnapshotCache'
import { getPublishVersion } from '../../publish/publishState'
import { isTemplatePage } from '@core/templates'
import { LOOP_RUNTIME_JS } from '../../publish/loopRuntime'

const LOOP_RUNTIME_PATH = '/_instatic/assets/loop-runtime.js'

export function isLoopRuntimeAssetPath(pathname: string): boolean {
  return pathname === LOOP_RUNTIME_PATH
}

export function serveLoopRuntimeAsset(): Response {
  return new Response(LOOP_RUNTIME_JS, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      // Aggressive caching — content is a fixed CMS asset that only
      // changes when the CMS itself ships a new version. We can re-deploy
      // by invalidating the path or appending a hash.
      'cache-control': 'public, max-age=3600',
    },
  })
}

interface LoopHandlerContext {
  db: DbClient
}

export async function handleLoopRequest(
  req: Request,
  url: URL,
  ctx: LoopHandlerContext,
): Promise<Response> {
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
  }

  // /_instatic/loop/<encoded-loopId>
  const loopId = decodeURIComponent(url.pathname.slice('/_instatic/loop/'.length))
  if (!loopId) return jsonResponse({ error: 'Missing loop id' }, { status: 400 })

  const pageNumberRaw = url.searchParams.get('page') ?? '1'
  const pageNumber = Math.max(1, Number.parseInt(pageNumberRaw, 10) || 1)

  // Find the page that contains this loop via the per-publish-version
  // loopId → { page, node } index. Every page version in one publish shares
  // the same site document, so the index covers regular pages and template
  // pages alike (the runtime's `pagePath` hint is no longer needed) — and the
  // old per-request full-snapshot parse + all-pages tree walk is gone.
  const loopIndex = await getPublishedLoopIndexForVersion(ctx.db, getPublishVersion())
  if (!loopIndex) {
    return jsonResponse({ error: 'Site not published' }, { status: 404 })
  }
  const indexed = loopIndex.loops.get(loopId)
  if (!indexed) {
    return jsonResponse({ error: 'Loop not found' }, { status: 404 })
  }
  const site = loopIndex.site
  const fallback = loopIndex.loops.get(loopId)
  const fallbackPage = fallback?.page
  const fallbackNode = fallback?.node

  // Resolve per pagePath: loop id sama bisa hidup di banyak halaman dengan
  // prop tersubstitusi BERBEDA (propOverrides ref VC — kategori/limit/
  // pagination per halaman). Resolver mengembalikan loop node SEKALIGUS
  // map node pemiliknya (definisi VC tersubstitusi) supaya render anak
  // loop punya halaman sintetis yang benar.
  const findLoopWithOwner = (
    curNodes: Record<string, PageNode>,
    rootNodeId: string,
    seenRefs: ReadonlySet<string>,
  ): { loopNode: PageNode; ownerNodes: Record<string, PageNode>; ownerRoot: string } | null => {
    const node = curNodes[rootNodeId]
    if (!node) return null
    if (node.moduleId === 'base.loop' && node.id === loopId) {
      return { loopNode: node, ownerNodes: curNodes, ownerRoot: rootNodeId }
    }
    if (node.moduleId === 'base.visual-component-ref') {
      const refProps = (node.props ?? {}) as Record<string, unknown>
      const componentId = typeof refProps['componentId'] === 'string' ? refProps['componentId'] : ''
      if (componentId && !seenRefs.has(rootNodeId)) {
        const vc = selectVisualComponentById(site, componentId)
        if (vc) {
          const overrides =
            refProps['propOverrides'] && typeof refProps['propOverrides'] === 'object'
              ? (refProps['propOverrides'] as Record<string, unknown>)
              : {}
          const substituted: Record<string, PageNode> = {}
          for (const [id, defNode] of Object.entries(vc.tree.nodes as Record<string, PageNode>)) {
            const bindings = defNode.propBindings
            if (!bindings || Object.keys(bindings).length === 0) {
              substituted[id] = defNode
              continue
            }
            const props = { ...defNode.props }
            for (const [propKey, binding] of Object.entries(bindings)) {
              const paramId = (binding as { paramId?: string } | undefined)?.paramId
              if (paramId && overrides[paramId] !== undefined) props[propKey] = overrides[paramId]
            }
            substituted[id] = { ...defNode, props }
          }
          const found = findLoopWithOwner(substituted, vc.tree.rootNodeId, new Set(seenRefs).add(rootNodeId))
          if (found) return found
        }
      }
    }
    for (const childId of node.children) {
      const found = findLoopWithOwner(curNodes, childId, seenRefs)
      if (found) return found
    }
    return null
  }

  let containingPage: Page | undefined = fallbackPage
  let ownerNodes: Record<string, PageNode> | undefined = fallbackPage?.nodes
  let ownerRoot: string | undefined =
    fallbackPage && fallbackNode ? fallbackPage.rootNodeId : undefined
  let loopNode: PageNode | undefined = fallbackNode

  const pagePath = url.searchParams.get('pagePath')
  if (pagePath) {
    const slug = pagePath.replace(/^\/+/, '').replace(/\/+$/, '')
    const candidate = site.pages.find(
      (pg) => pg.slug === slug && !isTemplatePage(pg),
    )
    if (candidate) {
      const found = findLoopWithOwner(candidate.nodes, candidate.rootNodeId, new Set())
      if (found) {
        containingPage = candidate
        loopNode = found.loopNode
        ownerNodes = found.ownerNodes
        ownerRoot = found.ownerRoot
      }
    }
  }
  if (!loopNode || !containingPage || !ownerNodes || !ownerRoot) {
    return jsonResponse({ error: 'Loop not found' }, { status: 404 })
  }

  const props = readLoopProps(loopNode)
  if (props.pagination !== 'infinite') {
    return jsonResponse({ error: 'Loop is not in infinite mode' }, { status: 400 })
  }
  const source = loopSourceRegistry.get(props.sourceId)
  if (!source) {
    return jsonResponse({ error: 'Source not registered' }, { status: 404 })
  }
  if (source.kind === 'contextual') {
    return jsonResponse({ error: 'Contextual loops do not support infinite pagination' }, { status: 400 })
  }

  // Fetch the requested page slice.
  const offset = props.offset + (pageNumber - 1) * props.pageSize
  let result
  try {
    result = await source.fetch({
      db: ctx.db,
      site,
      filters: props.filters,
      orderBy: props.orderBy || (source.orderByOptions[0]?.id ?? ''),
      direction: props.direction,
      limit: props.pageSize,
      offset,
    })
  } catch (err) {
    console.error(`[loop] source "${source.id}" failed for "${loopId}":`, err)
    return jsonResponse({ error: 'Source fetch failed' }, { status: 500 })
  }

  const consumed = offset + result.items.length
  const hasMore = consumed < result.totalItems

  // Render just the loop's children for the new items. We re-use the
  // publisher's renderNode walker by constructing a synthetic context;
  // CSS dedup is a no-op here because the asset bundle is already
  // loaded on the client.
  const variants = loopNode.children
  if (variants.length === 0) {
    return jsonResponse({ html: '', hasMore, pageNumber })
  }
  // Halaman sintetis: untuk loop di dalam VC, node anaknya hidup di tree
  // definisi (tersubstitusi), bukan di halaman.
  const syntheticPage: Page = { ...containingPage, nodes: ownerNodes, rootNodeId: ownerRoot }
  const baseConfig: RenderConfig = {
    page: syntheticPage,
    site,
    registry,
    breakpointId: undefined,
    templateContext: { entryStack: [] },
    loopData: new Map<string, ResolvedLoopRenderData>([
      [loopId, { items: result.items, totalItems: result.totalItems, pageNumber, hasMore }],
    ]),
  }
  const acc: RenderAccumulators = {
    cssMap: new Map(),
    jsMap: new Map(),
    infiniteLoopIds: new Set(),
    holeNodeIds: new Set(),
    cspSources: new Map(),
  }

  // Render each item by walking each variant child once per iteration.
  // Bypass renderLoop so we don't re-emit the wrapper element — the
  // existing wrapper on the client absorbs the appended fragments. Each
  // iteration derives a fresh config with a new entryStack snapshot rather
  // than mutating a shared array in place.
  let html = ''
  result.items.forEach((item, i) => {
    const variantId = variants[i % variants.length]
    const iterationConfig: RenderConfig = {
      ...baseConfig,
      // Spread the base templateContext so any page/site/route frames survive —
      // mirrors renderLoop.ts. Today the handler's base context carries no
      // frames, but spreading keeps the two iteration paths symmetric.
      templateContext: { ...baseConfig.templateContext, entryStack: [item] },
    }
    html += renderNode(variantId, iterationConfig, acc)
  })

  return jsonResponse({ html, hasMore, pageNumber })
}
