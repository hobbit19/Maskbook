import Services from '../../extension/service'
import { getStorage } from '../../utils/browser.storage'
import { getActivatedUI } from '../ui'

export async function shouldDisplayWelcomeDefault() {
    return false
    if (webpackEnv.firefoxVariant === 'GeckoView') return true
    const netId = getActivatedUI().networkIdentifier
    const storage = (await getStorage(netId)) || {}
    if (storage.forceDisplayWelcome) return true

    const ids = await Services.Identity.queryMyProfiles(netId)
    if (ids.length) return false

    if (storage.userIgnoredWelcome) return false
    return true
}
