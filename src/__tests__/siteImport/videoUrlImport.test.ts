/**
 * Regression test: base.video's `videoUrl` prop is a media URL and must be
 * treated as URL-bearing by the site-import asset pipeline — normalised to a
 * FileMap key by buildAssetPlan and rewritten to the uploaded media URL by
 * applyAssetRewrites (it was previously missing from URL_BEARING_PROPS).
 */

import { describe, it, expect } from 'bun:test'
// Self-registers all base modules with the global registry so importHtml works
import '@modules/base'
import { buildImportPlan, applyAssetRewrites } from '@core/siteImport'
import type { FileMap } from '@core/siteImport'
import { makeEmptySiteDocument } from './mockSite'
import { MINIMAL_PNG } from './fixtures'

const enc = new TextEncoder()
const txt = (s: string) => enc.encode(s)

describe('site import — base.video videoUrl asset rewriting', () => {
  it('normalises videoUrl to a FileMap key and rewrites it to the uploaded media URL', () => {
    const fileMap: FileMap = {
      files: {
        // Nested page so the raw src is NOT already in FileMap-key form —
        // proving the pipeline really resolved it.
        'pages/index.html': {
          bytes: txt('<html><body><video src="../assets/clip.webm" controls></video></body></html>'),
          mimeType: 'text/html',
        },
        'assets/clip.webm': { bytes: txt('webm'), mimeType: 'video/webm' },
        'assets/poster.png': { bytes: MINIMAL_PNG, mimeType: 'image/png' },
      },
    }
    const plan = buildImportPlan({ fileMap, currentSite: makeEmptySiteDocument() })

    // (a) buildAssetPlan normalised videoUrl to the FileMap key
    const videoNode = Object.values(plan.pages[0].nodeFragment.nodes).find(
      (n) => n.moduleId === 'base.video',
    )
    expect(videoNode?.props['videoUrl']).toBe('assets/clip.webm')
    expect(plan.assets.some((a) => a.sourcePath === 'assets/clip.webm')).toBe(true)

    // (b) applyAssetRewrites swaps in the uploaded media URL
    const rewriteMap: Record<string, string> = {}
    for (const asset of plan.assets) {
      rewriteMap[asset.sourcePath] = `/media/${asset.sourcePath.replace(/[^a-z0-9.]/g, '_')}`
    }
    const rewritten = applyAssetRewrites(plan, rewriteMap)
    const rewrittenNode = Object.values(rewritten.pages[0].nodeFragment.nodes).find(
      (n) => n.moduleId === 'base.video',
    )
    expect(rewrittenNode?.props['videoUrl']).toBe('/media/assets_clip.webm')
  })
})
