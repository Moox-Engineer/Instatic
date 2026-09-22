/**
 * Restart survival for the publish version.
 *
 * `publishVersion` is process memory, so a restart zeroes it while the baked
 * slot keeps its old stamp. The hole endpoint compares those stamps for strict
 * equality (`requestVersion !== String(currentVersion)` → stale sentinel), so
 * without hydration every `<instatic-hole>` on a freshly restarted site comes
 * back as `<instatic-hole-stale>` until somebody publishes (observed
 * 2026-09-22 on kacamatamoo staging: `docker restart` blanked both product
 * grids until a republish).
 *
 * Boot reads the stamps back from the active slot
 * (`readActiveSlotPublishVersion`) and restores the counter
 * (`hydratePublishVersion`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readActiveSlotPublishVersion,
  updateArtefactInPlace,
} from '../../../server/publish/staticArtefact'
import {
  bumpPublishVersion,
  getPublishVersion,
  hydratePublishVersion,
  resetPublishStateForTests,
} from '../../../server/publish/publishState'

const shell = (version: number): string =>
  `<html><body><instatic-hole data-instatic-version="${version}"></instatic-hole></body></html>`

let uploadsDir: string

beforeEach(async () => {
  uploadsDir = await mkdtemp(join(tmpdir(), 'publish-version-hydrate-'))
  resetPublishStateForTests()
})

afterEach(async () => {
  resetPublishStateForTests()
  await rm(uploadsDir, { recursive: true, force: true })
})

describe('readActiveSlotPublishVersion', () => {
  it('reads the stamp left by a full publish', async () => {
    await updateArtefactInPlace(uploadsDir, '/', shell(4))
    await updateArtefactInPlace(uploadsDir, '/id', shell(4))

    expect(await readActiveSlotPublishVersion(uploadsDir)).toBe(4)
  })

  it('returns the highest stamp after an incremental publish rewrote one page', async () => {
    // Full publish stamped the slot with 4, then a row publish rewrote ONE
    // artefact in place with the next version — the slot now carries 4 and 5.
    await updateArtefactInPlace(uploadsDir, '/', shell(4))
    await updateArtefactInPlace(uploadsDir, '/id', shell(5))

    expect(await readActiveSlotPublishVersion(uploadsDir)).toBe(5)
  })

  it('is null when nothing has been published yet', async () => {
    expect(await readActiveSlotPublishVersion(uploadsDir)).toBeNull()
  })

  it('is null when artefacts carry no hole stamps', async () => {
    await updateArtefactInPlace(uploadsDir, '/', '<html>no holes here</html>')

    expect(await readActiveSlotPublishVersion(uploadsDir)).toBeNull()
  })
})

describe('hydratePublishVersion', () => {
  it('restores the counter so a boot-time ?v= check matches the stamp', async () => {
    await updateArtefactInPlace(uploadsDir, '/', shell(6))

    // Fresh process: the counter starts at 0 (this is the restart bug).
    expect(getPublishVersion()).toBe(0)

    hydratePublishVersion((await readActiveSlotPublishVersion(uploadsDir))!)

    expect(getPublishVersion()).toBe(6)
    expect(String(getPublishVersion())).toBe('6') // hole endpoint compares strings
  })

  it('never lowers a counter that already moved past the stamp', () => {
    hydratePublishVersion(4)
    bumpPublishVersion() // 5 — e.g. an unpublish bumped before hydration ran
    hydratePublishVersion(4)
    expect(getPublishVersion()).toBe(5)
  })

  it('keeps publishing monotonic after hydration', async () => {
    await updateArtefactInPlace(uploadsDir, '/', shell(7))

    hydratePublishVersion((await readActiveSlotPublishVersion(uploadsDir))!)
    expect(bumpPublishVersion()).toBe(8)
  })
})
