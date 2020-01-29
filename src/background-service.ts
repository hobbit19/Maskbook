import { GetContext } from '@holoflows/kit/es'
import { MessageCenter } from './utils/messages'
/**
 * Load service here. sorry for the ugly pattern.
 * But here's some strange problem with webpack.
 *
 * you should also add register in './extension/service.ts'
 */
import * as CryptoService from './extension/background-script/CryptoService'
import * as WelcomeService from './extension/background-script/WelcomeService'
import * as IdentityService from './extension/background-script/IdentityService'
import * as UserGroupService from './extension/background-script/UserGroupService'
import * as SteganographyService from './extension/background-script/SteganographyService'
import * as PluginService from './extension/background-script/PluginService'
import { decryptFromMessageWithProgress } from './extension/background-script/CryptoServices/decryptFrom'
import { initAutoShareToFriends } from './extension/background-script/Jobs/AutoShareToFriends'

Object.assign(window, {
    CryptoService,
    WelcomeService,
    SteganographyService,
    IdentityService,
    UserGroupService,
    PluginService,
})
Object.assign(window, {
    ServicesWithProgress: {
        decryptFrom: decryptFromMessageWithProgress,
    },
})

import('./extension/service').then(() => import('./provider.worker'))

if (GetContext() === 'background') {
    const injectedScript = `{
        const script = document.createElement('script')
        script.src = "${browser.runtime.getURL('js/injected-script.js')}"
        document.documentElement.appendChild(script)
    }`
    const contentScripts: Array<{ code: string } | { file: string }> = []
    const contentScriptReady = fetch('generated__content__script.html')
        .then(x => x.text())
        .then(html => {
            const parser = new DOMParser()
            const root = parser.parseFromString(html, 'text/html')
            root.querySelectorAll('script').forEach(script => {
                if (script.innerText) contentScripts.push({ code: script.innerText })
                else if (script.src)
                    contentScripts.push({ file: new URL(script.src, browser.runtime.getURL('')).pathname })
            })
        })
    browser.webNavigation.onCommitted.addListener(async arg => {
        if (arg.url === 'about:blank') return
        await contentScriptReady
        browser.tabs
            .executeScript(arg.tabId, {
                runAt: 'document_start',
                frameId: arg.frameId,
                code: injectedScript,
            })
            .catch(IgnoreError(arg))
        for (const script of contentScripts) {
            const option: browser.extensionTypes.InjectDetails = {
                runAt: 'document_idle',
                frameId: arg.frameId,
                ...script,
            }
            try {
                await browser.tabs.executeScript(arg.tabId, option)
            } catch (e) {
                IgnoreError(e)
            }
        }
    })

    browser.runtime.onInstalled.addListener(async detail => {
        if (webpackEnv.target === 'WKWebview') return
        const { getWelcomePageURL } = await import('./extension/options-page/Welcome/getWelcomePageURL')
        if (detail.reason === 'install') {
            browser.tabs.create({ url: getWelcomePageURL() })
        }
    })

    if (webpackEnv.target === 'WKWebview') {
        contentScriptReady.then(() =>
            browser.tabs.create({
                url: 'https://m.facebook.com/',
                active: true,
            }),
        )
    }
    MessageCenter.on('closeActiveTab', async () => {
        const tabs = await browser.tabs.query({
            active: true,
        })
        if (tabs[0]) {
            await browser.tabs.remove(tabs[0].id!)
        }
    })
}
function IgnoreError(arg: unknown): (reason: Error) => void {
    return e => {
        if (e.message.includes('non-structured-clonable data')) {
            // It's okay we don't need the result, happened on Firefox
        } else if (e.message.includes('Frame not found, or missing host permission')) {
            // It's maybe okay, happened on Firefox
        } else if (e.message.includes('must request permission')) {
            // It's okay, we inject to the wrong site and browser rejected it.
        } else if (e.message.includes('Cannot access a chrome')) {
            // It's okay, we inject to the wrong site and browser rejected it.
        } else console.error('Inject error', e, arg, Object.entries(e))
    }
}
import('./social-network/worker').then(({ defineSocialNetworkWorker }) => {
    Object.assign(globalThis, { defineSocialNetworkWorker })
})

import * as PersonaDB from './database/Persona/Persona.db'
import * as PersonaDBHelper from './database/Persona/helpers'

// Friendly to debug
Object.assign(window, {
    gun1: import('./network/gun/version.1'),
    gun2: import('./network/gun/version.2'),
    crypto40: import('./crypto/crypto-alpha-40'),
    crypto39: import('./crypto/crypto-alpha-39'),
    crypto38: import('./crypto/crypto-alpha-38'),
    db: {
        avatar: import('./database/avatar'),
        group: import('./database/group'),
        deprecated_people: import('./database/migrate/_deprecated_people_db'),
        persona: PersonaDB,
        personaHelper: PersonaDBHelper,
        type: import('./database/type'),
        post: import('./database/post'),
    },
})
initAutoShareToFriends()
